import type { Member } from "./model";

export interface MemberStore {
  find(workspaceId: string, userId: string): Promise<Member | null>;
  list(workspaceId: string): Promise<Member[]>;
  listForCaller(): Promise<Member[]>;
}

export interface MemberAdmin {
  find(workspaceId: string, userId: string): Promise<Member | null>;
  list(workspaceId: string): Promise<Member[]>;
  save(member: Member): Promise<void>;
  delete(workspaceId: string, userId: string): Promise<void>;
}
