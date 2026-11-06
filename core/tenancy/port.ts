import type { AuthUser, VerifiedCaller } from "../auth/types";
import type { Authorizer } from "../auth/authorizer";
import type { WorkspaceAdmin, WorkspaceStore } from "../workspace/repository";
import type { MemberAdmin, MemberStore } from "../member/repository";

export interface Tenancy {
  /**
   * Throws `UnknownAccountError` when the directory has no user for a valid
   * token, and `TenancyUnavailableError` when it cannot be reached.
   */
  enter(caller: VerifiedCaller | null): Promise<{ user: AuthUser | null; scope: TenantScope }>;
}

export type TenantScope = {
  workspaces: WorkspaceStore;
  members: MemberStore;
  authorizer: Authorizer;
  admin: TenancyAdmin | null;
};

export type TenancyAdmin = {
  workspaces: WorkspaceAdmin;
  members: MemberAdmin;
};

export class TenancyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TenancyUnavailableError";
  }
}

export class UnknownAccountError extends Error {
  constructor() {
    super("No directory user is linked to this identity");
    this.name = "UnknownAccountError";
  }
}
