import type { Project } from "./model";

export interface ProjectStore {
  save(project: Project): Promise<void>;
  find(id: string): Promise<Project | null>;
  list(ownerId: string): Promise<Project[]>;
  delete(id: string, ownerId: string): Promise<void>;
}
