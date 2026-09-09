import type { ProjectStore } from "../repository";

export async function deleteProject(
  projects: ProjectStore,
  id: string,
  ownerId: string,
): Promise<boolean> {
  const project = await projects.find(id);
  if (!project) return false;
  if (project.ownerId !== ownerId) return false;
  await projects.delete(id, ownerId);
  return true;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockProjects(): ProjectStore & { store: Map<string, any> } {
    const store = new Map<string, any>();
    return {
      store,
      save: vi.fn(async (p: any) => { store.set(p.id, p); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      list: vi.fn(async () => [...store.values()]),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
    };
  }

  test("deleteProject deletes own project", async () => {
    const ps = mockProjects();
    ps.store.set("p1", { id: "p1", name: "Test", ownerId: "u1", createdAt: 0, updatedAt: 0 });

    const result = await deleteProject(ps, "p1", "u1");
    expect(result).toBe(true);
    expect(ps.delete).toHaveBeenCalledWith("p1", "u1");
  });

  test("deleteProject rejects non-owner", async () => {
    const ps = mockProjects();
    ps.store.set("p1", { id: "p1", name: "Test", ownerId: "u1", createdAt: 0, updatedAt: 0 });

    const result = await deleteProject(ps, "p1", "u2");
    expect(result).toBe(false);
    expect(ps.delete).not.toHaveBeenCalled();
  });

  test("deleteProject returns false for non-existent", async () => {
    const ps = mockProjects();
    const result = await deleteProject(ps, "nope", "u1");
    expect(result).toBe(false);
  });
}
