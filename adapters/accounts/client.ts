import { z } from "zod";
import type { BearerCredential } from "../../core/auth/types";
import type { ProjectAction, WorkspaceAction } from "../../core/auth/permissions";
import { TenancyUnavailableError, UnknownAccountError } from "../../core/tenancy/port";
import { ACCOUNTS_SERVICE } from "./roles";

export const ACCOUNTS_TIMEOUT_MS = 3000;
export const RESOURCE_ID_FIELD = "resource_id";

const meWire = z.object({ id: z.string() });

const aliasWire = z.string().min(1).brand<"WorkspaceAlias">();

export type WorkspaceAlias = z.infer<typeof aliasWire>;

const workspaceWire = z.object({
  id: z.string(),
  name: z.string(),
  alias: aliasWire,
  created_at: z.iso.datetime({ offset: true }).nullish(),
  deleted_at: z.iso.datetime({ offset: true }).nullish(),
  members: z.array(z.object({ user_id: z.string().optional(), role: z.string() })),
});

const checkWire = z.object({ allowed: z.boolean() });

export type DirectoryWorkspace = {
  id: string;
  name: string;
  alias: WorkspaceAlias;
  createdAt?: number;
  deactivated: boolean;
  members: { userId: string; role: string }[];
};

export type ResourceCheck =
  | { kind: "workspace"; action: WorkspaceAction }
  | { kind: "project"; action: ProjectAction; projectId: string };

export type PermissionCheck = { workspaceAlias: WorkspaceAlias } & ResourceCheck;

export class AccountsClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = ACCOUNTS_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async me(credential: BearerCredential): Promise<string> {
    const { id } = await this.request(credential, "GET", "/api/users/me", undefined, meWire);
    return id;
  }

  async workspacesOf(credential: BearerCredential, userId: string): Promise<DirectoryWorkspace[]> {
    const path = `/api/workspaces?user_id=${encodeURIComponent(userId)}`;
    const wire = await this.request(credential, "GET", path, undefined, z.array(workspaceWire));
    return wire.map((ws) => ({
      id: ws.id,
      name: ws.name,
      alias: ws.alias,
      createdAt: ws.created_at ? Date.parse(ws.created_at) : undefined,
      deactivated: Boolean(ws.deleted_at),
      members: ws.members.flatMap((m) => (m.user_id ? [{ userId: m.user_id, role: m.role }] : [])),
    }));
  }

  async checkPermission(credential: BearerCredential, check: PermissionCheck): Promise<boolean> {
    const body = {
      service: ACCOUNTS_SERVICE,
      resource: check.kind,
      action: check.action,
      workspace_alias: check.workspaceAlias,
      ...(check.kind === "project" ? { [RESOURCE_ID_FIELD]: check.projectId } : {}),
    };
    const { allowed } = await this.request(credential, "POST", "/api/permissions/check", body, checkWire);
    return allowed;
  }

  private async request<T>(
    credential: BearerCredential,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const route = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential.reveal()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new TenancyUnavailableError(`Accounts did not answer ${route}`, { cause });
    }
    if (res.status === 401) throw new UnknownAccountError();
    if (!res.ok) throw new TenancyUnavailableError(`Accounts answered ${res.status} to ${route}`);
    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      throw new TenancyUnavailableError(`Accounts did not answer ${route}`, { cause });
    }
    return parseWithoutEcho(text, schema, route);
  }
}

function parseWithoutEcho<T>(text: string, schema: z.ZodType<T>, route: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TenancyUnavailableError(`Accounts answered ${route} with a body that is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new TenancyUnavailableError(`Accounts answered ${route} with an unexpected shape at ${paths}`);
  }
  return parsed.data;
}

if (import.meta.vitest) {
  const { test, expect, vi, describe, afterEach } = import.meta.vitest;
  const { inspect } = await import("node:util");
  const { BearerCredential } = await import("../../core/auth/types");

  const TOKEN = "secret-token";
  const credential = new BearerCredential(TOKEN);
  const SECRET_EMAIL = "leak@example.test";

  function clientAnswering(answer: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(answer);
    const fetchImpl: typeof fetch = (input, init) => fetchMock(String(input), init ?? {});
    return { client: new AccountsClient("http://accounts.test/", fetchImpl, timeoutMs), fetchMock };
  }

  const workspace = {
    id: "ws1", name: "Team", alias: "team", personal: false, created_at: "2026-01-02T03:04:05Z",
    members: [{ user_id: "u1", role: "owner" }, { integration_id: "i1", role: "writer" }],
  };

  describe("AccountsClient", () => {
    afterEach(() => vi.restoreAllMocks());

    test("me sends the caller's token and returns the accounts user id", async () => {
      const { client, fetchMock } = clientAnswering(async () => Response.json({ id: "u1", email: SECRET_EMAIL }));
      expect(await client.me(credential)).toBe("u1");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://accounts.test/api/users/me");
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    });

    test("workspacesOf reads the caller's workspaces unpaged and keeps user members only", async () => {
      const { client, fetchMock } = clientAnswering(async () => Response.json([workspace]));
      expect(await client.workspacesOf(credential, "u 1")).toEqual([{
        id: "ws1", name: "Team", alias: "team", createdAt: Date.parse("2026-01-02T03:04:05Z"), deactivated: false,
        members: [{ userId: "u1", role: "owner" }],
      }]);
      expect(fetchMock.mock.calls[0][0]).toBe("http://accounts.test/api/workspaces?user_id=u%201");
    });

    test("a workspace with deleted_at set is marked deactivated", async () => {
      const { client } = clientAnswering(async () => Response.json([{ ...workspace, deleted_at: "2026-03-04T05:06:07.123456Z" }]));
      expect((await client.workspacesOf(credential, "u1"))[0].deactivated).toBe(true);
    });

    test.each([
      ["an empty alias", { alias: "" }],
      ["a deleted_at that is not a timestamp", { deleted_at: "yes" }],
    ])("%s makes the directory unavailable", async (_, patch) => {
      const { client } = clientAnswering(async () => Response.json([{ ...workspace, ...patch }]));
      await expect(client.workspacesOf(credential, "u1")).rejects.toBeInstanceOf(TenancyUnavailableError);
    });

    test("checkPermission sends the serve service, the alias and the project under resource_id", async () => {
      const { client, fetchMock } = clientAnswering(async () => Response.json({ allowed: true }));
      const allowed = await client.checkPermission(credential, {
        kind: "project", action: "create_asset", workspaceAlias: "team" as WorkspaceAlias, projectId: "p1",
      });
      expect(allowed).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://accounts.test/api/permissions/check");
      expect(JSON.parse(String(init.body))).toEqual({
        service: "serve", resource: "project", action: "create_asset", workspace_alias: "team", resource_id: "p1",
      });
    });

    test("a workspace check sends no resource_id", async () => {
      const { client, fetchMock } = clientAnswering(async () => Response.json({ allowed: false }));
      expect(await client.checkPermission(credential, { kind: "workspace", action: "read", workspaceAlias: "team" as WorkspaceAlias })).toBe(false);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty(RESOURCE_ID_FIELD);
    });

    test.each([
      [500, TenancyUnavailableError],
      [403, TenancyUnavailableError],
      [204, TenancyUnavailableError],
      [401, UnknownAccountError],
    ])("a %i carrying an allow is never read as a decision", async (status, error) => {
      const body = status === 204 ? null : `{"allowed":true}`;
      const { client } = clientAnswering(async () => new Response(body, { status }));
      const check = { kind: "workspace", action: "read", workspaceAlias: "team" as WorkspaceAlias } as const;
      await expect(client.checkPermission(credential, check)).rejects.toBeInstanceOf(error);
    });

    test("a redirect is refused rather than followed", async () => {
      const { client, fetchMock } = clientAnswering(async () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }),
      );
      await expect(client.me(credential)).rejects.toBeInstanceOf(TenancyUnavailableError);
      expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    });

    test("the default timeout is 3 seconds", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      await new AccountsClient("http://accounts.test", async () => Response.json({ id: "u1" })).me(credential);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(3000);
    });

    test("a 401 means the directory has no user for this identity", async () => {
      const { client } = clientAnswering(async () => new Response("unauthorized", { status: 401 }));
      await expect(client.me(credential)).rejects.toBeInstanceOf(UnknownAccountError);
    });

    test.each([
      ["a 500", async () => new Response(`{"error":"${SECRET_EMAIL}"}`, { status: 500 })],
      ["a refused connection", async () => { throw new TypeError("fetch failed"); }],
      ["a malformed body", async () => new Response(`<html>${SECRET_EMAIL}</html>`, { status: 200 })],
      ["a body of the wrong shape", async () => Response.json([{ id: 1, name: SECRET_EMAIL, members: "x" }])],
    ])("%s makes the directory unavailable and keeps the body out of the error", async (_, answer) => {
      const { client } = clientAnswering(answer);
      const error = await client.workspacesOf(credential, "u1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TenancyUnavailableError);
      expect(inspect(error, { depth: 10 })).not.toContain(SECRET_EMAIL);
      expect(inspect(error, { depth: 10 })).not.toContain(TOKEN);
    });

    test("an answer slower than the timeout makes the directory unavailable", async () => {
      const { client } = clientAnswering((_, init) => new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }), 20);
      const error = await client.me(credential).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TenancyUnavailableError);
      expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
    });

    test("nothing the client does logs a response body", async () => {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}));
      const { client } = clientAnswering(async () => Response.json([{ ...workspace, name: SECRET_EMAIL }]));
      await client.workspacesOf(credential, "u1");
      await clientAnswering(async () => new Response(SECRET_EMAIL, { status: 503 })).client.me(credential).catch(() => {});
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });
}
