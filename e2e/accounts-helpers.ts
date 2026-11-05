import { readFile } from "node:fs/promises";
import { AccountsClient, type ResourceCheck, type WorkspaceAlias, type toAccountsRole } from "../adapters/accounts";
import { BearerCredential } from "../core/auth/types";
import { signToken } from "./helpers";

export const ACCOUNTS = process.env.E2E_ACCOUNTS_URL ?? "";
const PHASES = ["fresh", "migrated", "down"] as const;
export const PHASE = PHASES.find((phase) => phase === process.env.E2E_ACCOUNTS_PHASE) ?? "fresh";
export const NONCE = process.env.E2E_ACCOUNTS_NONCE ?? `${Date.now()}`;
export const ACCOUNTS_LOG = process.env.E2E_ACCOUNTS_LOG ?? "";

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

export async function accounts<T>(method: string, path: string, body: unknown, sub?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sub) headers.Authorization = `Bearer ${await signToken(identity(sub))}`;
  const res = await fetch(`${ACCOUNTS}${path}`, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} as ${sub ?? "nobody"}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export function subOf(label: string): string {
  return `${label}-${NONCE}`;
}

export async function signupUser(label: string): Promise<AccountsUser> {
  const sub = subOf(label);
  const { id } = await accounts<{ id: string }>("POST", "/api/users/signup-oidc", identity(sub));
  return { sub, id };
}

export function teamAlias(team = "serve-team"): WorkspaceAlias {
  return `${team}-${NONCE}` as WorkspaceAlias;
}

/** Accounts cannot grant `owner` over REST, so the workspace creator is its only owner. */
export async function seedWorkspace(
  owner: AccountsUser,
  members: { user: AccountsUser; role: Exclude<AccountsRole, "owner"> }[],
  alias = teamAlias(),
): Promise<string> {
  const { id } = await accounts<{ id: string }>("POST", "/api/workspaces", { alias, name: alias }, owner.sub);
  const users = members.map(({ user, role }) => ({ user_id: user.id, role }));
  await accounts("POST", `/api/workspaces/${id}/members`, { users }, owner.sub);
  return id;
}

export async function accountsCheck(sub: string, check: ResourceCheck): Promise<boolean> {
  const credential = new BearerCredential(await signToken(identity(sub)));
  return new AccountsClient(ACCOUNTS).checkPermission(credential, { workspaceAlias: teamAlias(), ...check });
}

export async function accountsRequestLines(): Promise<string[]> {
  const log = await readFile(ACCOUNTS_LOG, "utf8");
  return log.split("\n").flatMap((line) => line.match(/<-- (GET|POST|PATCH|DELETE) \S+/)?.[0] ?? []);
}
