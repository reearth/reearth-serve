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
    // Metadata, user_meta, version metadata and the active-version switch
    // (asset/handler/update-asset, update-version, set-active-version all
    // check "update"). It was missing, so every update was denied.
    update: new Set(["owner", "admin", "editor"]),
    delete: new Set(["owner", "admin", "editor"]),
    extract: new Set(["owner", "admin", "editor"]),
    // Claiming and releasing site names (ADR-013 B2/B3): the same bar as an
    // asset update, so a viewer can see an asset's names but not change them.
    "manage-hosts": new Set(["owner", "admin", "editor"]),
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
