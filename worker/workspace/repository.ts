import type { Workspace } from "./model";

export interface WorkspaceStore {
  save(workspace: Workspace): Promise<void>;
  find(id: string): Promise<Workspace | null>;
  delete(id: string): Promise<void>;
}
