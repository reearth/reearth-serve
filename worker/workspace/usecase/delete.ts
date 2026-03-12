import type { WorkspaceStore } from "../repository";
import type { MemberStore } from "../../member/repository";

export async function deleteWorkspace(
  workspaces: WorkspaceStore,
  members: MemberStore,
  id: string,
): Promise<boolean> {
  const ws = await workspaces.find(id);
  if (!ws) return false;

  // Remove all members
  const memberList = await members.list(id);
  for (const m of memberList) {
    await members.delete(id, m.userId);
  }

  await workspaces.delete(id);
  return true;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  test("deleteWorkspace removes workspace and all members", async () => {
    const ws: WorkspaceStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => ({ id: "ws1", name: "Test", createdAt: 0, updatedAt: 0 })),
      delete: vi.fn(async () => {}),
    };
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => [
        { workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 0, updatedAt: 0 },
        { workspaceId: "ws1", userId: "u2", role: "editor" as const, createdAt: 0, updatedAt: 0 },
      ]),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    const result = await deleteWorkspace(ws, ms, "ws1");
    expect(result).toBe(true);
    expect(ws.delete).toHaveBeenCalledWith("ws1");
    expect(ms.delete).toHaveBeenCalledTimes(2);
  });

  test("deleteWorkspace returns false for non-existent workspace", async () => {
    const ws: WorkspaceStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    };
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    const result = await deleteWorkspace(ws, ms, "nope");
    expect(result).toBe(false);
  });
}
