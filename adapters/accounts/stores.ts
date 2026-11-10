import type { Member, Workspace } from "../../shared/api";
import type { MemberStore } from "../../core/member/repository";
import type { WorkspaceStore } from "../../core/workspace/repository";
import type { AccountsSession } from "./session";

export class AccountsWorkspaceStore implements WorkspaceStore {
  constructor(private readonly session: AccountsSession) {}

  async find(id: string): Promise<Workspace | null> {
    return (await this.session.snapshot()).get(id)?.workspace ?? null;
  }
}

export class AccountsMemberStore implements MemberStore {
  constructor(private readonly session: AccountsSession) {}

  async find(workspaceId: string, userId: string): Promise<Member | null> {
    return (await this.session.snapshot()).get(workspaceId)?.members.get(userId) ?? null;
  }

  async list(workspaceId: string): Promise<Member[]> {
    return [...((await this.session.snapshot()).get(workspaceId)?.members.values() ?? [])];
  }

  async listForCaller(): Promise<Member[]> {
    const mine: Member[] = [];
    for (const { members } of (await this.session.snapshot()).values()) {
      const member = members.get(this.session.userId);
      if (member) mine.push(member);
    }
    return mine;
  }
}

if (import.meta.vitest) {
  const { test, expect, vi, describe } = import.meta.vitest;
  const { BearerCredential } = await import("../../core/auth/types");
  const { AccountsSession } = await import("./session");

  type DirectoryWorkspace = import("./client").DirectoryWorkspace;
  type WorkspaceAlias = import("./client").WorkspaceAlias;
  const workspaces: DirectoryWorkspace[] = [
    { id: "ws1", name: "Team", alias: "team" as WorkspaceAlias, deactivated: false, members: [{ userId: "me", role: "reader" }, { userId: "boss", role: "owner" }] },
    { id: "ws2", name: "Mine", alias: "me" as WorkspaceAlias, deactivated: false, members: [{ userId: "me", role: "owner" }] },
    { id: "ws3", name: "Elsewhere", alias: "x" as WorkspaceAlias, deactivated: false, members: [{ userId: "boss", role: "owner" }] },
  ];

  function stores() {
    const client = { workspacesOf: vi.fn(async () => workspaces), checkPermission: vi.fn() };
    const session = new AccountsSession(client, new BearerCredential("t"), "me", async () => {});
    return { client, workspaceStore: new AccountsWorkspaceStore(session), memberStore: new AccountsMemberStore(session) };
  }

  describe("accounts read stores", () => {
    test("read the caller's workspaces and members from one snapshot", async () => {
      const { client, workspaceStore, memberStore } = stores();
      expect(await workspaceStore.find("ws1")).toEqual({ id: "ws1", name: "Team" });
      expect(await workspaceStore.find("ws3")).toBeNull();
      expect(await memberStore.find("ws1", "boss")).toEqual({ workspaceId: "ws1", userId: "boss", role: "owner" });
      expect(await memberStore.find("ws1", "nobody")).toBeNull();
      expect((await memberStore.list("ws1")).map((m) => m.userId)).toEqual(["me", "boss"]);
      expect(await memberStore.list("ws3")).toEqual([]);
      expect(client.workspacesOf).toHaveBeenCalledOnce();
    });

    test("listForCaller returns the caller's own membership in each workspace", async () => {
      expect(await stores().memberStore.listForCaller()).toEqual([
        { workspaceId: "ws1", userId: "me", role: "viewer" },
        { workspaceId: "ws2", userId: "me", role: "owner" },
      ]);
    });
  });
}
