import type { Member } from "../../../shared/api";
import type { MemberStore } from "../repository";

export async function listMembers(
  members: MemberStore,
  workspaceId: string,
): Promise<Member[]> {
  return members.list(workspaceId);
}
