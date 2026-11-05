import type { ProjectStore } from "../repository";

export async function deleteProject(projects: ProjectStore, id: string): Promise<void> {
  await projects.delete(id);
}
