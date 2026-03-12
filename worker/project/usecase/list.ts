import type { Project } from "../../../shared/api";
import type { ProjectStore } from "../repository";

export async function listProjects(
  projects: ProjectStore,
  params: { ownerId?: string; workspaceId?: string },
): Promise<Project[]> {
  return projects.list(params);
}
