import type { Project } from "../../../shared/api";
import type { ProjectStore } from "../repository";

export async function listProjects(
  projects: ProjectStore,
  ownerId: string,
): Promise<Project[]> {
  return projects.list(ownerId);
}
