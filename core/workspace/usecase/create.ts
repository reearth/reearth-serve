import type { Workspace } from "../../../shared/api";
import type { WorkspaceStore } from "../repository";
import type { MemberStore } from "../../member/repository";

export async function createWorkspace(
  workspaces: WorkspaceStore,
  members: MemberStore,
  name: string,
  userId: string,
): Promise<Workspace> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = Date.now();
  const workspace: Workspace = { id, name, createdAt: now, updatedAt: now };
  await workspaces.save(workspace);

  // Creator becomes owner
  await members.save({
    workspaceId: id,
    userId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });

  return workspace;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  test("createWorkspace creates workspace and adds creator as owner", async () => {
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

    const result = await createWorkspace(ws, ms, "Test WS", "user-1");

    expect(result.name).toBe("Test WS");
    expect(result.id).toHaveLength(16);
    expect(ws.save).toHaveBeenCalledOnce();
    expect(ms.save).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: result.id,
      userId: "user-1",
      role: "owner",
    }));
  });
}
