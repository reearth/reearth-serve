import type { Workspace } from "../../../shared/api";
import type { WorkspaceStore } from "../repository";

export async function getWorkspace(
  workspaces: WorkspaceStore,
  id: string,
): Promise<Workspace | null> {
  return workspaces.find(id);
}
