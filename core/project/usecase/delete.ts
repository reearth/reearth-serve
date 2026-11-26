import type { ProjectStore } from "../repository";
import type { CompatStore } from "../../compat/repository";

export async function deleteProject(projects: ProjectStore, compat: CompatStore, id: string): Promise<void> {
  await compat.deleteProject(id);
  await projects.delete(id);
}
