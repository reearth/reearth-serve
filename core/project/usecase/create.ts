import type { Project } from "../../../shared/api";
import type { ProjectStore } from "../repository";

export async function createProject(
  projects: ProjectStore,
  name: string,
  ownerId: string,
  workspaceId?: string,
): Promise<Project> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = Date.now();
  const project: Project = {
    id, name, createdAt: now, updatedAt: now, ownerId,
    ...(workspaceId && { workspaceId }),
  };
  await projects.save(project);
  return project;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockProjects(): ProjectStore {
    const store = new Map<string, Project>();
    return {
      save: vi.fn(async (p: Project) => { store.set(p.id, p); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      list: vi.fn(async () => [...store.values()]) as ProjectStore["list"],
      delete: vi.fn(),
    };
  }

  test("createProject creates a project with correct fields", async () => {
    const ps = mockProjects();
    const project = await createProject(ps, "My Project", "user-123");

    expect(project.name).toBe("My Project");
    expect(project.ownerId).toBe("user-123");
    expect(project.id).toHaveLength(16);
    expect(ps.save).toHaveBeenCalledOnce();
  });
}
