import type { BearerCredential } from "../../core/auth/types";
import type { Member, Workspace } from "../../shared/api";
import { UnknownAccountError } from "../../core/tenancy/port";
import type { AccountsClient, DirectoryWorkspace, PermissionCheck, WorkspaceAlias } from "./client";
import { fromAccountsRole } from "./roles";

export type SnapshotWorkspace = {
  workspace: Workspace;
  alias: WorkspaceAlias;
  members: ReadonlyMap<string, Member>;
};

export type Snapshot = ReadonlyMap<string, SnapshotWorkspace>;

export function buildSnapshot(callerId: string, workspaces: DirectoryWorkspace[]): Snapshot {
  const snapshot = new Map<string, SnapshotWorkspace>();
  for (const ws of workspaces) {
    if (ws.deactivated) continue;
    const members = new Map<string, Member>();
    for (const { userId, role: accountsRole } of ws.members) {
      const role = fromAccountsRole(accountsRole);
      if (role) members.set(userId, { workspaceId: ws.id, userId, role });
    }
    if (!members.has(callerId)) continue;
    snapshot.set(ws.id, {
      workspace: { id: ws.id, name: ws.name, ...(ws.createdAt === undefined ? {} : { createdAt: ws.createdAt }) },
      alias: ws.alias,
      members,
    });
  }
  return snapshot;
}

export class AccountsSession {
  private pending: Promise<Snapshot> | null = null;

  constructor(
    private readonly client: Pick<AccountsClient, "workspacesOf" | "checkPermission">,
    private readonly credential: BearerCredential,
    readonly userId: string,
    private readonly forgetUserId: () => Promise<void>,
  ) {}

  snapshot(): Promise<Snapshot> {
    this.pending ??= this.forgettingOnUnknown(this.client.workspacesOf(this.credential, this.userId))
      .then((workspaces) => buildSnapshot(this.userId, workspaces));
    return this.pending;
  }

  check(check: PermissionCheck): Promise<boolean> {
    return this.forgettingOnUnknown(this.client.checkPermission(this.credential, check));
  }

  private async forgettingOnUnknown<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof UnknownAccountError) await this.forgetUserId();
      throw error;
    }
  }
}

if (import.meta.vitest) {
  const { test, expect, vi, describe } = import.meta.vitest;
  const { BearerCredential } = await import("../../core/auth/types");
  const { TenancyUnavailableError } = await import("../../core/tenancy/port");

  const noForget = async () => {};
  const team: DirectoryWorkspace = {
    id: "ws1", name: "Team", alias: "team" as WorkspaceAlias, createdAt: 5, deactivated: false,
    members: [
      { userId: "me", role: "writer" },
      { userId: "boss", role: "owner" },
      { userId: "partial", role: "limited" },
    ],
  };

  describe("buildSnapshot", () => {
    test("maps accounts roles to Serve roles and keeps the workspace timestamp", () => {
      const ws1 = buildSnapshot("me", [team]).get("ws1");
      expect(ws1?.workspace).toEqual({ id: "ws1", name: "Team", createdAt: 5 });
      expect(ws1?.alias).toBe("team");
      expect([...(ws1?.members.values() ?? [])]).toEqual([
        { workspaceId: "ws1", userId: "me", role: "editor" },
        { workspaceId: "ws1", userId: "boss", role: "owner" },
      ]);
    });

    test("drops a workspace whose members do not include the caller", () => {
      const other: DirectoryWorkspace = { ...team, id: "ws2", members: [{ userId: "boss", role: "owner" }] };
      expect([...buildSnapshot("me", [team, other]).keys()]).toEqual(["ws1"]);
    });

    test("drops a limited member, and a workspace where the caller is limited", () => {
      expect(buildSnapshot("me", [team]).get("ws1")?.members.has("partial")).toBe(false);
      expect(buildSnapshot("partial", [team]).size).toBe(0);
    });

    test("drops a deactivated workspace, so it grants nothing", () => {
      const gone: DirectoryWorkspace = { ...team, id: "ws2", deactivated: true };
      expect([...buildSnapshot("me", [team, gone]).keys()]).toEqual(["ws1"]);
    });

    test("an integration member never reaches the snapshot", async () => {
      const { AccountsClient } = await import("./client");
      const wire = [{ id: "ws1", name: "T", alias: "t", members: [{ user_id: "me", role: "reader" }, { integration_id: "i1", role: "owner" }] }];
      const client = new AccountsClient("http://accounts.test", async () => Response.json(wire));
      const snapshot = buildSnapshot("me", await client.workspacesOf(new BearerCredential("t"), "me"));
      expect([...(snapshot.get("ws1")?.members.keys() ?? [])]).toEqual(["me"]);
    });
  });

  describe("AccountsSession", () => {
    test("many reads in one request share one membership fetch", async () => {
      const client = { workspacesOf: vi.fn(async () => [team]), checkPermission: vi.fn() };
      const session = new AccountsSession(client, new BearerCredential("t"), "me", noForget);
      await Promise.all([session.snapshot(), session.snapshot()]);
      await session.snapshot();
      expect(client.workspacesOf).toHaveBeenCalledOnce();
    });

    test.each(["snapshot", "check"] as const)("a 401 from %s forgets the cached user id", async (method) => {
      const unknown = async () => { throw new UnknownAccountError(); };
      const client = { workspacesOf: vi.fn(unknown), checkPermission: vi.fn(unknown) };
      const forget = vi.fn(noForget);
      const session = new AccountsSession(client, new BearerCredential("t"), "me", forget);
      const call = method === "snapshot"
        ? session.snapshot()
        : session.check({ kind: "workspace", action: "read", workspaceAlias: "team" as WorkspaceAlias });
      await expect(call).rejects.toBeInstanceOf(UnknownAccountError);
      expect(forget).toHaveBeenCalledOnce();
    });

    test("a directory outage keeps the cached user id", async () => {
      const client = { workspacesOf: vi.fn(async () => { throw new TenancyUnavailableError("down"); }), checkPermission: vi.fn() };
      const forget = vi.fn(noForget);
      await expect(new AccountsSession(client, new BearerCredential("t"), "me", forget).snapshot()).rejects.toThrow("down");
      expect(forget).not.toHaveBeenCalled();
    });
  });
}
