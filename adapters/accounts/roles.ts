import type { Role } from "../../shared/api";

export const ACCOUNTS_SERVICE = "serve";

const ACCOUNTS_ROLE = {
  viewer: "reader",
  editor: "writer",
  admin: "maintainer",
  owner: "owner",
} as const satisfies Record<Role, string>;

export type AccountsRole = (typeof ACCOUNTS_ROLE)[Role];

export function toAccountsRole(role: Role): AccountsRole {
  return ACCOUNTS_ROLE[role];
}

export function fromAccountsRole(name: string): Role | null {
  const match = Object.entries(ACCOUNTS_ROLE).find(([, accountsRole]) => accountsRole === name);
  return match ? (match[0] as Role) : null;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  const PAIRS: [Role, AccountsRole][] = [
    ["viewer", "reader"],
    ["editor", "writer"],
    ["admin", "maintainer"],
    ["owner", "owner"],
  ];

  test.each(PAIRS)("%s maps to %s and back", (serve, accounts) => {
    expect(toAccountsRole(serve)).toBe(accounts);
    expect(fromAccountsRole(accounts)).toBe(serve);
  });

  test.each(["limited", "self", "viewer", "Owner", "constructor", ""])("%j has no Serve role", (name) => {
    expect(fromAccountsRole(name)).toBeNull();
  });
}
