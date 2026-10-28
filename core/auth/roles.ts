import type { Role } from "../../shared/api";

/** Permission map: resource kind → action → allowed roles */
const permissions: Record<string, Record<string, Set<Role>>> = {
  workspace: {
    read: new Set(["owner", "admin", "editor", "viewer"]),
    update: new Set(["owner", "admin"]),
    delete: new Set(["owner"]),
    "manage-members": new Set(["owner", "admin"]),
  },
  project: {
    read: new Set(["owner", "admin", "editor", "viewer"]),
    create: new Set(["owner", "admin"]),
    delete: new Set(["owner"]),
  },
  asset: {
    read: new Set(["owner", "admin", "editor", "viewer"]),
    create: new Set(["owner", "admin", "editor"]),
    delete: new Set(["owner", "admin", "editor"]),
    extract: new Set(["owner", "admin", "editor"]),
  },
  job: {
    read: new Set(["owner", "admin", "editor", "viewer"]),
    retry: new Set(["owner", "admin", "editor"]),
  },
};

/**
 * Check if any of the given roles has permission for the action on the resource kind.
 */
export function hasPermission(roles: Role[], resourceKind: string, action: string): boolean {
  const kindPerms = permissions[resourceKind];
  if (!kindPerms) return false;

  const allowedRoles = kindPerms[action];
  if (!allowedRoles) return false;

  return roles.some((role) => allowedRoles.has(role));
}

const roleRank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Whether `actor` may grant, change or revoke `role`. `manage-members` alone
 * would let an admin promote anyone, themselves included, to owner, then remove
 * the original owner. Nobody can act on a role above their own.
 */
export function canManageRole(actor: Role, role: Role): boolean {
  return roleRank[actor] >= roleRank[role];
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("canManageRole blocks acting above one's own role", () => {
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("admin", "admin")).toBe(true);
    expect(canManageRole("admin", "viewer")).toBe(true);
    expect(canManageRole("owner", "owner")).toBe(true);
    expect(canManageRole("editor", "admin")).toBe(false);
  });
}
