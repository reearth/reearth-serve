import type { Project } from "../../../shared/api";
import type { ProjectListScope, ProjectStore } from "../repository";

export async function listProjects(projects: ProjectStore, scope: ProjectListScope): Promise<Project[]> {
  return projects.list(scope);
}
