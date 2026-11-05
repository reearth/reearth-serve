import type { WorkspaceStore } from "../repository";
import type { MemberStore } from "../../member/repository";
import type { ProjectStore } from "../../project/repository";
import type { Project } from "../../project/model";

export type DeleteWorkspaceResult = "deleted" | "not_found" | "has_projects";

export async function deleteWorkspace(
  workspaces: WorkspaceStore,
  members: MemberStore,
  projects: ProjectStore,
  id: string,
): Promise<DeleteWorkspaceResult> {
  const ws = await workspaces.find(id);
  if (!ws) return "not_found";
  if ((await projects.list({ workspaceId: id })).length > 0) return "has_projects";

  const memberList = await members.list(id);
  for (const m of memberList) {
    await members.delete(id, m.userId);
  }

  await workspaces.delete(id);
  return "deleted";
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function stores(projectList: Project[] = []) {
    const ws: WorkspaceStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async (id: string) => (id === "ws1" ? { id: "ws1", name: "Test", createdAt: 0, updatedAt: 0 } : null)),
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
    const ps: ProjectStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => projectList),
      delete: vi.fn(async () => {}),
    };
    return { ws, ms, ps };
  }

  test("deleteWorkspace removes workspace and all members", async () => {
    const { ws, ms, ps } = stores();
    expect(await deleteWorkspace(ws, ms, ps, "ws1")).toBe("deleted");
    expect(ps.list).toHaveBeenCalledWith({ workspaceId: "ws1" });
    expect(ws.delete).toHaveBeenCalledWith("ws1");
    expect(ms.delete).toHaveBeenCalledTimes(2);
  });

  test("deleteWorkspace refuses a workspace that still has projects and deletes nothing", async () => {
    const { ws, ms, ps } = stores([{ id: "p1", name: "p", workspaceId: "ws1", ownerId: "u1", createdAt: 0, updatedAt: 0 }]);
    expect(await deleteWorkspace(ws, ms, ps, "ws1")).toBe("has_projects");
    expect(ws.delete).not.toHaveBeenCalled();
    expect(ms.delete).not.toHaveBeenCalled();
  });

  test("deleteWorkspace returns not_found for non-existent workspace", async () => {
    const { ws, ms, ps } = stores();
    expect(await deleteWorkspace(ws, ms, ps, "nope")).toBe("not_found");
    expect(ws.delete).not.toHaveBeenCalled();
  });
}
