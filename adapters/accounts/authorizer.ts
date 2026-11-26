import { isWorkspaceRequest, type Authorizer, type AuthzRequest } from "../../core/auth/authorizer";
import type { ResourceCheck } from "./client";
import type { AccountsSession } from "./session";

/** Accounts resolves the caller's roles from the token, so `principal.role` is not sent. */
export class AccountsAuthorizer implements Authorizer {
  constructor(private readonly session: AccountsSession) {}

  async check(req: AuthzRequest): Promise<boolean> {
    if (req.principal.id !== this.session.userId) return false;
    const entry = (await this.session.snapshot()).get(req.workspaceId);
    if (!entry) return false;
    const check: ResourceCheck = isWorkspaceRequest(req)
      ? { kind: "workspace", action: req.action }
      : { kind: "project", action: req.action, projectId: req.resource.projectId };
    return this.session.check({ workspaceAlias: entry.alias, ...check });
  }
}

if (import.meta.vitest) {
  const { test, expect, vi, describe } = import.meta.vitest;
  const { BearerCredential } = await import("../../core/auth/types");
  const { AccountsSession } = await import("./session");
  type WorkspaceAlias = import("./client").WorkspaceAlias;

  function decider(principalId = "me") {
    const client = {
      workspacesOf: vi.fn(async () => [{ id: "ws1", name: "Team", alias: "team-now" as WorkspaceAlias, deactivated: false, members: [{ userId: "me", role: "writer" }] }]),
      checkPermission: vi.fn(async () => true),
    };
    const pdp = new AccountsAuthorizer(new AccountsSession(client, new BearerCredential("t"), "me", async () => {}));
    const principal = { id: principalId, role: "editor" as const };
    return { client, pdp, principal };
  }

  describe("AccountsAuthorizer", () => {
    test("asks accounts with the alias from this request's snapshot and the project id", async () => {
      const { client, pdp, principal } = decider();
      expect(await pdp.check({ principal, workspaceId: "ws1", resource: { kind: "project", projectId: "p1" }, action: "create_asset" })).toBe(true);
      expect(client.checkPermission).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        kind: "project", action: "create_asset", workspaceAlias: "team-now", projectId: "p1",
      });
    });

    test("a workspace check carries no project id", async () => {
      const { client, pdp, principal } = decider();
      await pdp.check({ principal, workspaceId: "ws1", resource: { kind: "workspace" }, action: "read" });
      expect(client.checkPermission).toHaveBeenCalledWith(expect.anything(), { kind: "workspace", action: "read", workspaceAlias: "team-now" });
    });

    test("denies a principal other than the session's user without asking accounts", async () => {
      const { client, pdp, principal } = decider("someone-else");
      expect(await pdp.check({ principal, workspaceId: "ws1", resource: { kind: "workspace" }, action: "read" })).toBe(false);
      expect(client.workspacesOf).not.toHaveBeenCalled();
      expect(client.checkPermission).not.toHaveBeenCalled();
    });

    test("denies a workspace missing from the snapshot without a check", async () => {
      const { client, pdp, principal } = decider();
      expect(await pdp.check({ principal, workspaceId: "ws9", resource: { kind: "project", projectId: "p9" }, action: "read" })).toBe(false);
      expect(client.checkPermission).not.toHaveBeenCalled();
    });
  });
}
