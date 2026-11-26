import type { KeyValue } from "../../core/kv/port";
import type { AuthUser, VerifiedCaller } from "../../core/auth/types";
import type { Tenancy, TenantScope } from "../../core/tenancy/port";
import type { AccountsClient } from "./client";
import { forgetAccountsUserId, resolveAccountsUserId, type IdentityMemory } from "./identity";
import { AccountsSession } from "./session";
import { AccountsMemberStore, AccountsWorkspaceStore } from "./stores";
import { AccountsAuthorizer } from "./authorizer";

const ANONYMOUS_SCOPE: TenantScope = {
  workspaces: { find: async () => null },
  members: { find: async () => null, list: async () => [], listForCaller: async () => [] },
  authorizer: { check: async () => false },
  admin: null,
};

export class AccountsTenancy implements Tenancy {
  constructor(private readonly deps: { client: AccountsClient; kv: KeyValue; memory?: IdentityMemory }) {}

  async enter(caller: VerifiedCaller | null): Promise<{ user: AuthUser | null; scope: TenantScope }> {
    if (!caller) return { user: null, scope: ANONYMOUS_SCOPE };
    const id = await resolveAccountsUserId(caller, this.deps);
    const session = new AccountsSession(this.deps.client, caller.credential, id, () => forgetAccountsUserId(caller.sub, this.deps));
    return {
      user: { id, sub: caller.sub, email: caller.email, name: caller.name },
      scope: {
        workspaces: new AccountsWorkspaceStore(session),
        members: new AccountsMemberStore(session),
        authorizer: new AccountsAuthorizer(session),
        admin: null,
      },
    };
  }
}

if (import.meta.vitest) {
  const { test, expect, describe } = import.meta.vitest;
  const { Hono } = await import("hono");
  const { MemoryKeyValue } = await import("../memory/memory-kv");
  const { BearerCredential } = await import("../../core/auth/types");
  const { AccountsClient } = await import("./client");
  const { identityMemory } = await import("./identity");
  const { UnknownAccountError } = await import("../../core/tenancy/port");
  const { enterCaller, tenancyMiddleware } = await import("../../core/tenancy/middleware");
  const { accessCtx, authorizeAsset, authorizeProject } = await import("../../core/auth/access");
  type AppEnv = import("../../core/types").AppEnv;
  type ProjectStore = import("../../core/project/repository").ProjectStore;
  type AssetMetadata = import("../../core/asset/model").AssetMetadata;

  const asset = (owner: Pick<AssetMetadata, "sessionId" | "projectId">): AssetMetadata =>
    ({ id: "a1", filename: "f.txt", contentType: "text/plain", size: 1, createdAt: 0, expiresAt: 0, ...owner });

  const caller: VerifiedCaller = { kind: "user", sub: "idp|will", email: "will@example.test", credential: new BearerCredential("t") };
  const teamProject = { id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "acc-alice", workspaceId: "ws1" };
  const projects: ProjectStore = {
    save: async () => {}, list: async () => [], delete: async () => {},
    find: async (id) => (id === teamProject.id ? teamProject : null),
  };

  function fakeAccounts() {
    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      "GET /api/users/me": { id: "acc-will" },
      "GET /api/workspaces": [
        { id: "ws1", name: "Team", alias: "team", members: [{ user_id: "acc-will", role: "writer" }, { user_id: "acc-alice", role: "owner" }] },
        { id: "ws2", name: "will", alias: "will", members: [{ user_id: "acc-will", role: "owner" }] },
      ],
      "POST /api/permissions/check": { allowed: true },
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const call = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
      calls.push(call);
      return answers[call] === 401 ? new Response(null, { status: 401 }) : Response.json(answers[call]);
    };
    return { calls, answers, client: new AccountsClient("http://accounts.test", fetchImpl) };
  }

  function serve(tenancy: Tenancy) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("caller", caller);
      c.set("projects", projects);
      c.set("sessionId", null);
      await next();
    });
    app.use("*", tenancyMiddleware(tenancy));
    app.post("/api/v1/assets", async (c) => c.json(await authorizeProject(accessCtx(c), "p1", "create_asset")));
    app.get("/api/v1/me", async (c) => {
      const { members, workspaces } = c.get("tenancy");
      const mine = await members.listForCaller();
      return c.json(await Promise.all(mine.map((m) => workspaces.find(m.workspaceId))));
    });
    app.get("/api/v1/assets/session-asset", async (c) => c.json(await authorizeAsset(accessCtx(c), asset({ sessionId: "s1" }), "read_asset")));
    app.get("/api/v1/health", (c) => c.json({ ok: true }));
    app.get("/files/restricted", async (c) => {
      await enterCaller(c, c.get("caller"));
      return c.json(await authorizeAsset(accessCtx(c), asset({ projectId: "p1" }), "read_asset"));
    });
    return app;
  }

  async function callsFor(app: ReturnType<typeof serve>, calls: string[], path: string, method = "GET") {
    const before = calls.length;
    const res = await app.request(path, { method });
    expect(res.status).toBe(200);
    return calls.slice(before);
  }

  describe("AccountsTenancy call budget", () => {
    test("warm identity cache: a project route makes 2 calls, /me 1, a session asset read and health 0", async () => {
      const { calls, client } = fakeAccounts();
      const app = serve(new AccountsTenancy({ client, kv: new MemoryKeyValue(), memory: identityMemory() }));
      await app.request("/api/v1/health");
      await callsFor(app, calls, "/api/v1/me");
      expect(await callsFor(app, calls, "/api/v1/assets", "POST")).toEqual(["GET /api/workspaces", "POST /api/permissions/check"]);
      expect(await callsFor(app, calls, "/api/v1/me")).toEqual(["GET /api/workspaces"]);
      expect(await callsFor(app, calls, "/api/v1/assets/session-asset")).toEqual([]);
      expect(await callsFor(app, calls, "/api/v1/health")).toEqual([]);
    });

    test("a cold identity cache adds the one /me lookup", async () => {
      const { calls, client } = fakeAccounts();
      const app = serve(new AccountsTenancy({ client, kv: new MemoryKeyValue(), memory: identityMemory() }));
      expect(await callsFor(app, calls, "/api/v1/assets", "POST")).toEqual([
        "GET /api/users/me", "GET /api/workspaces", "POST /api/permissions/check",
      ]);
    });

    test("a restricted file read that binds the caller costs 2 calls warm and 3 cold", async () => {
      const { calls, client } = fakeAccounts();
      const app = serve(new AccountsTenancy({ client, kv: new MemoryKeyValue(), memory: identityMemory() }));
      expect(await callsFor(app, calls, "/files/restricted")).toHaveLength(3);
      expect(await callsFor(app, calls, "/files/restricted")).toEqual(["GET /api/workspaces", "POST /api/permissions/check"]);
    });

    test("the bound directory user is the accounts user, keeping the token's profile", async () => {
      const { client } = fakeAccounts();
      const { user, scope } = await new AccountsTenancy({ client, kv: new MemoryKeyValue(), memory: identityMemory() }).enter(caller);
      expect(user).toEqual({ id: "acc-will", sub: "idp|will", email: "will@example.test", name: undefined });
      expect(scope.admin).toBeNull();
    });

    test("a deactivated workspace grants nothing and costs no permission check", async () => {
      const { calls, answers, client } = fakeAccounts();
      answers["GET /api/workspaces"] = [{
        id: "ws1", name: "Team", alias: "team", deleted_at: "2026-11-01T00:00:00Z",
        members: [{ user_id: "acc-will", role: "writer" }, { user_id: "acc-alice", role: "owner" }],
      }];
      const app = serve(new AccountsTenancy({ client, kv: new MemoryKeyValue(), memory: identityMemory() }));
      const res = await app.request("/api/v1/assets", { method: "POST" });
      expect(await res.json()).toEqual({ ok: false, reason: "not_found" });
      expect(calls).not.toContain("POST /api/permissions/check");
    });

    test("a 401 after the identity lookup forgets the cached user id", async () => {
      const { calls, answers, client } = fakeAccounts();
      const deps = { client, kv: new MemoryKeyValue(), memory: identityMemory() };
      const tenancy = new AccountsTenancy(deps);
      await tenancy.enter(caller);
      answers["GET /api/workspaces"] = 401;
      const { scope } = await tenancy.enter(caller);
      await expect(scope.members.listForCaller()).rejects.toBeInstanceOf(UnknownAccountError);
      expect(deps.memory.ids.size).toBe(0);
      expect(deps.kv.size).toBe(0);
      await tenancy.enter(caller);
      expect(calls.filter((call) => call === "GET /api/users/me")).toHaveLength(2);
    });

    test("an anonymous request makes no call and sees nothing", async () => {
      const { calls, client } = fakeAccounts();
      const { user, scope } = await new AccountsTenancy({ client, kv: new MemoryKeyValue() }).enter(null);
      expect(user).toBeNull();
      expect(await scope.members.listForCaller()).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
}
