import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toAccountsRole } from "../adapters/accounts";
import { allows, policyEntries, type PolicyEntry } from "../core/auth/permissions";
import { roleSchema, type Role } from "../shared/api";
import { PHASE, accountsCheck, accountsReachable, seedWorkspace, signupUser, subOf } from "./accounts-helpers";

const reachable = await accountsReachable();

const MEMBER = { owner: "alice", maintainer: "mara", writer: "will", reader: "rita" } as const;
const NON_MEMBER = "dave";

const PROJECT_ID = "contract-project";

function checkOf(entry: PolicyEntry) {
  return entry.kind === "project" ? { ...entry, projectId: PROJECT_ID } : entry;
}

const cells = roleSchema.options.flatMap((serveRole) =>
  policyEntries().map((entry) => ({
    role: toAccountsRole(serveRole),
    serveRole,
    rule: `${entry.kind}.${entry.action}`,
    entry,
  })),
);

function expected(role: Role, entry: PolicyEntry): boolean {
  return entry.kind === "workspace" ? allows(role, entry.kind, entry.action) : allows(role, entry.kind, entry.action);
}

describe.runIf(reachable && PHASE === "fresh")("the accounts policy matches POLICY", () => {
  const answers: Record<string, Record<string, boolean>> = {};

  beforeAll(async () => {
    const [alice, mara, will, rita] = await Promise.all(
      [MEMBER.owner, MEMBER.maintainer, MEMBER.writer, MEMBER.reader].map(signupUser),
    );
    await signupUser(NON_MEMBER);
    await seedWorkspace(alice, [
      { user: mara, role: "maintainer" },
      { user: will, role: "writer" },
      { user: rita, role: "reader" },
    ]);
  });

  afterAll(() => {
    console.table(answers);
  });

  test.each(cells)("$role $rule", async ({ role, serveRole, rule, entry }) => {
    const allowed = await accountsCheck(subOf(MEMBER[role]), checkOf(entry));
    (answers[rule] ??= {})[role] = allowed;
    expect(allowed).toBe(expected(serveRole, entry));
  });

  test("a signed-up non-member is denied every action", async () => {
    const allowed = [];
    for (const entry of policyEntries()) {
      if (await accountsCheck(subOf(NON_MEMBER), checkOf(entry))) allowed.push(`${entry.kind}.${entry.action}`);
    }
    expect(allowed).toEqual([]);
  });
});

describe.runIf(reachable && PHASE === "migrated")("after the role migration", () => {
  test("tripwire for accounts issue #266: a migrated reader is allowed workspace create_project", async () => {
    const createProject = { kind: "workspace", action: "create_project" } as const;
    const rita = await accountsCheck(subOf(MEMBER.reader), createProject);
    const dave = await accountsCheck(subOf(NON_MEMBER), createProject);
    console.log(`create_project after migration: ${MEMBER.reader}=${rita} ${NON_MEMBER}=${dave}`);
    expect(
      rita,
      "accounts no longer merges global roles into workspace roles (#266): the role floor of ADR-016 decision 3 can move to the effective role",
    ).toBe(true);
  });
});
