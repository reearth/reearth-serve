import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import type { VerifiedCaller } from "../auth/types";
import { TenancyUnavailableError, UnknownAccountError, type Tenancy, type TenancyAdmin } from "./port";

export const TENANCY_RETRY_AFTER_SECONDS = 5;

const UNBOUND_API_PATHS = new Set(["/api/v1/health", "/api/v1/doc", "/api/v1/docs"]);

export function bindsCaller(path: string): boolean {
  return path.startsWith("/api/v1/") && !UNBOUND_API_PATHS.has(path);
}

export async function enterCaller(c: Context<AppEnv>, caller: VerifiedCaller | null): Promise<void> {
  const { user, scope } = await c.get("directory").enter(caller);
  c.set("user", user);
  c.set("tenancy", scope);
}

export function tenancyMiddleware(tenancy: Tenancy) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("directory", tenancy);
    await enterCaller(c, bindsCaller(c.req.path) ? c.get("caller") : null);
    await next();
  });
}

export function requireTenancyAdmin(c: Context<AppEnv>): TenancyAdmin | Response {
  return c.get("tenancy").admin
    ?? c.json({ error: "Workspaces and members are managed by an external directory" }, 405);
}

export function tenancyErrorResponse(err: Error, c: Context<AppEnv>): Response | null {
  if (err instanceof UnknownAccountError) {
    return c.json({ error: "No directory user is linked to this identity" }, 401);
  }
  if (err instanceof TenancyUnavailableError) {
    console.error(err);
    c.header("Retry-After", String(TENANCY_RETRY_AFTER_SECONDS));
    return c.json({ error: "Authorization service unavailable" }, 503);
  }
  return null;
}

if (import.meta.vitest) {
  const { test, expect, vi, describe } = import.meta.vitest;
  const { Hono } = await import("hono");
  const { BearerCredential } = await import("../auth/types");

  const caller: VerifiedCaller = { kind: "user", sub: "idp-1", credential: new BearerCredential("t0ken") };
  const stores = { find: vi.fn(), list: vi.fn(), listForCaller: vi.fn(), save: vi.fn(), delete: vi.fn() };
  const admin: TenancyAdmin = { workspaces: stores, members: stores };

  function fakeTenancy(opts: { fail?: Error; admin?: TenancyAdmin | null } = {}) {
    return {
      enter: vi.fn(async (who: VerifiedCaller | null) => {
        if (who && opts.fail) throw opts.fail;
        return {
          user: who ? { id: `dir-${who.sub}`, sub: who.sub } : null,
          scope: { workspaces: stores, members: stores, authorizer: { check: vi.fn() }, admin: opts.admin === undefined ? admin : opts.admin },
        };
      }),
    } satisfies Tenancy;
  }

  function appWith(tenancy: Tenancy) {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => tenancyErrorResponse(err, c) ?? c.text("unexpected", 500));
    app.use("*", async (c, next) => {
      c.set("caller", caller);
      await next();
    });
    app.use("*", tenancyMiddleware(tenancy));
    app.get("/api/v1/me", (c) => c.json({ user: c.get("user") }));
    app.get("/api/v1/health", (c) => c.json({ user: c.get("user") }));
    app.post("/api/v1/workspaces", (c) => {
      const granted = requireTenancyAdmin(c);
      return granted instanceof Response ? granted : c.json({ ok: true }, 201);
    });
    app.get("/files/:id", async (c) => {
      await enterCaller(c, c.get("caller"));
      return c.json({ user: c.get("user") });
    });
    return app;
  }

  describe("tenancyMiddleware", () => {
    test("binds the caller to the directory user on API routes", async () => {
      const tenancy = fakeTenancy();
      const res = await appWith(tenancy).request("/api/v1/me");
      expect(await res.json()).toEqual({ user: { id: "dir-idp-1", sub: "idp-1" } });
      expect(tenancy.enter).toHaveBeenCalledExactlyOnceWith(caller);
    });

    test("an identity the directory does not know answers 401 with a neutral message", async () => {
      const res = await appWith(fakeTenancy({ fail: new UnknownAccountError() })).request("/api/v1/me");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "No directory user is linked to this identity" });
    });

    test("an unreachable directory answers 503 with Retry-After", async () => {
      vi.spyOn(console, "error").mockImplementationOnce(() => {});
      const res = await appWith(fakeTenancy({ fail: new TenancyUnavailableError("down") })).request("/api/v1/me");
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toEqual({ error: "Authorization service unavailable" });
    });

    test("health never enters the directory with the caller", async () => {
      const tenancy = fakeTenancy();
      const res = await appWith(tenancy).request("/api/v1/health");
      expect(await res.json()).toEqual({ user: null });
      expect(tenancy.enter).not.toHaveBeenCalledWith(caller);
    });

    test("a skipped route binds the caller only when it calls enterCaller", async () => {
      const tenancy = fakeTenancy();
      const res = await appWith(tenancy).request("/files/a1");
      expect(await res.json()).toEqual({ user: { id: "dir-idp-1", sub: "idp-1" } });
      expect(tenancy.enter.mock.calls.filter(([who]) => who === caller)).toHaveLength(1);
    });
  });

  describe("requireTenancyAdmin", () => {
    test("answers 405 when an external directory owns membership", async () => {
      const res = await appWith(fakeTenancy({ admin: null })).request("/api/v1/workspaces", { method: "POST" });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "Workspaces and members are managed by an external directory" });
    });

    test("passes the admin handle through for the local directory", async () => {
      expect((await appWith(fakeTenancy()).request("/api/v1/workspaces", { method: "POST" })).status).toBe(201);
    });
  });
}
