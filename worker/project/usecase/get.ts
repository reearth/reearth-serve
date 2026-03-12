import type { Project } from "../../../shared/api";
import type { ProjectStore } from "../repository";

export async function getProject(
  projects: ProjectStore,
  id: string,
): Promise<Project | null> {
  return projects.find(id);
}
