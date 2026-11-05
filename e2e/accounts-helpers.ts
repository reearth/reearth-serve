import { ACCOUNTS_SERVICE, type toAccountsRole } from "../adapters/accounts";
import type { ProjectAction, WorkspaceAction } from "../core/auth/permissions";
import { signToken } from "./helpers";

export const ACCOUNTS = process.env.E2E_ACCOUNTS_URL ?? "";
export const PHASE: "fresh" | "migrated" = process.env.E2E_ACCOUNTS_PHASE === "migrated" ? "migrated" : "fresh";
export const NONCE = process.env.E2E_ACCOUNTS_NONCE ?? `${Date.now()}`;

type AccountsRole = ReturnType<typeof toAccountsRole>;
export type AccountsUser = { sub: string; id: string };

export async function accountsReachable(): Promise<boolean> {
  if (!ACCOUNTS) return false;
  try {
    return (await fetch(`${ACCOUNTS}/api/auth/config`)).ok;
  } catch {
    return false;
  }
}

function identity(sub: string) {
  return { sub, email: `${sub}@example.com`, name: sub };
}

async function accounts<T>(method: string, path: string, body: unknown, sub?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sub) headers.Authorization = `Bearer ${await signToken(identity(sub))}`;
  const res = await fetch(`${ACCOUNTS}${path}`, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} as ${sub ?? "nobody"}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function subOf(label: string): string {
  return `${label}-${NONCE}`;
}

export async function signupUser(label: string): Promise<AccountsUser> {
  const sub = subOf(label);
  const { id } = await accounts<{ id: string }>("POST", "/api/users/signup-oidc", identity(sub));
  return { sub, id };
}

export function teamAlias(): string {
  return `serve-team-${NONCE}`;
}

/** Accounts cannot grant `owner` over REST, so the workspace creator is its only owner. */
export async function seedWorkspace(
  owner: AccountsUser,
  members: { user: AccountsUser; role: Exclude<AccountsRole, "owner"> }[],
): Promise<void> {
  const alias = teamAlias();
  const { id } = await accounts<{ id: string }>("POST", "/api/workspaces", { alias, name: alias }, owner.sub);
  const users = members.map(({ user, role }) => ({ user_id: user.id, role }));
  await accounts("POST", `/api/workspaces/${id}/members`, { users }, owner.sub);
}

export type ResourceCheck =
  | { kind: "workspace"; action: WorkspaceAction }
  | { kind: "project"; action: ProjectAction; projectId: string };

export async function accountsCheck(sub: string, check: ResourceCheck): Promise<boolean> {
  const { allowed } = await accounts<{ allowed: boolean }>(
    "POST",
    "/api/permissions/check",
    {
      service: ACCOUNTS_SERVICE,
      resource: check.kind,
      action: check.action,
      workspace_alias: teamAlias(),
      ...(check.kind === "project" ? { resource_id: check.projectId } : {}),
    },
    sub,
  );
  return allowed;
}
