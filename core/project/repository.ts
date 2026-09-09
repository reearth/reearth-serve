import type { Project } from "./model";

export interface ProjectStore {
  save(project: Project): Promise<void>;
  find(id: string): Promise<Project | null>;
  list(params: { ownerId?: string; workspaceId?: string }): Promise<Project[]>;
  delete(id: string, ownerId: string): Promise<void>;
}
