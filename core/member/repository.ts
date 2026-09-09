import type { Member } from "./model";

export interface MemberStore {
  save(member: Member): Promise<void>;
  find(workspaceId: string, userId: string): Promise<Member | null>;
  list(workspaceId: string): Promise<Member[]>;
  listByUser(userId: string): Promise<Member[]>;
  delete(workspaceId: string, userId: string): Promise<void>;
}
