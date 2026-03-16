import type { Role } from "../../shared/api";
import type { Authorizer, AuthzRequest } from "../auth/authorizer";
import { hasPermission } from "../auth/roles";

/**
 * SimpleAuthorizer — in-process role-based authorization.
 * Uses the permission map from roles.ts. No external service needed.
 * Suitable for local development and testing.
 */
export class SimpleAuthorizer implements Authorizer {
  async check(req: AuthzRequest): Promise<boolean> {
    return hasPermission(req.principal.roles as Role[], req.resource.kind, req.action);
  }
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  const authorizer = new SimpleAuthorizer();

  // --- Workspace permissions ---

  test("owner can do everything on workspace", async () => {
    const base = { resource: { kind: "workspace", id: "ws1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "update" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "delete" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "manage-members" })).toBe(true);
  });

  test("admin can update and manage-members on workspace but not delete", async () => {
    const base = { resource: { kind: "workspace", id: "ws1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "update" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "manage-members" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "delete" })).toBe(false);
  });

  test("editor can only read workspace", async () => {
    const base = { resource: { kind: "workspace", id: "ws1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["editor"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["editor"] }, ...base, action: "update" })).toBe(false);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["editor"] }, ...base, action: "delete" })).toBe(false);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["editor"] }, ...base, action: "manage-members" })).toBe(false);
  });

  test("viewer can only read workspace", async () => {
    const base = { resource: { kind: "workspace", id: "ws1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["viewer"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["viewer"] }, ...base, action: "update" })).toBe(false);
  });

  // --- Project permissions ---

  test("owner can do everything on project", async () => {
    const base = { resource: { kind: "project", id: "p1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "create" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["owner"] }, ...base, action: "delete" })).toBe(true);
  });

  test("admin can create projects but not delete", async () => {
    const base = { resource: { kind: "project", id: "p1" } };
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "read" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "create" })).toBe(true);
    expect(await authorizer.check({ principal: { id: "u1", roles: ["admin"] }, ...base, action: "delete" })).toBe(false);
  });

  test("editor can create/delete assets but not projects", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "asset", id: "a1" },
      action: "create",
    })).toBe(true);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "asset", id: "a1" },
      action: "delete",
    })).toBe(true);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "project", id: "p1" },
      action: "delete",
    })).toBe(false);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "project", id: "p1" },
      action: "create",
    })).toBe(false);
  });

  test("viewer can only read", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "asset", id: "a1" },
      action: "read",
    })).toBe(true);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "asset", id: "a1" },
      action: "create",
    })).toBe(false);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "asset", id: "a1" },
      action: "delete",
    })).toBe(false);
  });

  test("editor can extract assets, viewer cannot", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "asset", id: "a1" },
      action: "extract",
    })).toBe(true);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "asset", id: "a1" },
      action: "extract",
    })).toBe(false);
  });

  test("viewer can read jobs but not retry", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "job", id: "j1" },
      action: "read",
    })).toBe(true);
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["viewer"] },
      resource: { kind: "job", id: "j1" },
      action: "retry",
    })).toBe(false);
  });

  test("editor can retry jobs", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "job", id: "j1" },
      action: "retry",
    })).toBe(true);
  });

  test("unknown resource kind is denied", async () => {
    expect(await authorizer.check({
      principal: { id: "u1", roles: ["owner"] },
      resource: { kind: "unknown", id: "x" },
      action: "read",
    })).toBe(false);
  });
}
