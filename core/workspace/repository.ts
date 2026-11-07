import type { Workspace } from "./model";

export interface WorkspaceStore {
  find(id: string): Promise<Workspace | null>;
}

export interface WorkspaceAdmin {
  find(id: string): Promise<Workspace | null>;
  save(workspace: Workspace): Promise<void>;
  delete(id: string): Promise<void>;
}
