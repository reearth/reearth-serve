import type { Project } from "./model";

export type ProjectListScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "created"; ownerId: string; memberOf: readonly string[] };

export interface ProjectStore {
  save(project: Project): Promise<void>;
  find(id: string): Promise<Project | null>;
  list(scope: ProjectListScope): Promise<Project[]>;
  delete(id: string): Promise<void>;
}
