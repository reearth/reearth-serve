import type { Role } from "../../shared/api";
import { isWorkspaceRequest, type Authorizer, type AuthzRequest } from "./authorizer";

export const POLICY = {
  workspace: {
    read: "viewer",
    delete: "owner",
    manage_members: "admin",
    create_project: "admin",
  },
  project: {
    read: "viewer",
    delete: "owner",
    read_asset: "viewer",
    create_asset: "editor",
    update_asset: "editor",
    manage_hosts: "editor",
    delete_asset: "editor",
    extract_asset: "editor",
    read_job: "viewer",
    retry_job: "editor",
    manage_webhooks: "admin",
  },
} as const satisfies Record<string, Record<string, Role>>;

export type ResourceKind = keyof typeof POLICY;
export type ActionOf<K extends ResourceKind> = keyof (typeof POLICY)[K] & string;
export type WorkspaceAction = ActionOf<"workspace">;
export type ProjectAction = ActionOf<"project">;

export type PolicyEntry = {
  [K in ResourceKind]: { kind: K; action: ActionOf<K>; minimum: Role };
}[ResourceKind];

const policy: { [K in ResourceKind]: Record<ActionOf<K>, Role> } = POLICY;

const roleRank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function allows<K extends ResourceKind>(role: Role, kind: K, action: ActionOf<K>): boolean {
  return roleRank[role] >= roleRank[policy[kind][action]];
}

export function withinPolicy(req: AuthzRequest): boolean {
  return isWorkspaceRequest(req)
    ? allows(req.principal.role, "workspace", req.action)
    : allows(req.principal.role, "project", req.action);
}

function entriesOf<K extends ResourceKind>(kind: K): PolicyEntry[] {
  const actions = policy[kind];
  return (Object.keys(actions) as ActionOf<K>[]).map(
    (action) => ({ kind, action, minimum: actions[action] }) as PolicyEntry,
  );
}

export function policyEntries(): PolicyEntry[] {
  return [...entriesOf("workspace"), ...entriesOf("project")];
}

/**
 * Whether `actor` may grant, change or revoke `role`. `manage_members` alone
 * would let an admin promote anyone, themselves included, to owner, then remove
 * the original owner. Nobody can act on a role above their own.
 */
export function canManageRole(actor: Role, role: Role): boolean {
  return roleRank[actor] >= roleRank[role];
}

export class SimpleAuthorizer implements Authorizer {
  async check(req: AuthzRequest): Promise<boolean> {
    return withinPolicy(req);
  }
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  const LADDER: Role[] = ["viewer", "editor", "admin", "owner"];

  function decide(role: Role, entry: PolicyEntry): boolean {
    return entry.kind === "workspace"
      ? allows(role, entry.kind, entry.action)
      : allows(role, entry.kind, entry.action);
  }

  function actualTable(): Record<string, boolean[]> {
    return Object.fromEntries(
      policyEntries().map((e) => [`${e.kind}.${e.action}`, LADDER.map((role) => decide(role, e))]),
    );
  }

  test("allows() matches a hand-written role table in every cell", () => {
    const expected: Record<string, [boolean, boolean, boolean, boolean]> = {
      "workspace.read": [true, true, true, true],
      "workspace.delete": [false, false, false, true],
      "workspace.manage_members": [false, false, true, true],
      "workspace.create_project": [false, false, true, true],
      "project.read": [true, true, true, true],
      "project.delete": [false, false, false, true],
      "project.read_asset": [true, true, true, true],
      "project.create_asset": [false, true, true, true],
      "project.update_asset": [false, true, true, true],
      "project.manage_hosts": [false, true, true, true],
      "project.delete_asset": [false, true, true, true],
      "project.extract_asset": [false, true, true, true],
      "project.read_job": [true, true, true, true],
      "project.retry_job": [false, true, true, true],
      "project.manage_webhooks": [false, false, true, true],
    };
    expect(actualTable()).toEqual(expected);
  });

  test("the README role table matches POLICY", async () => {
    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf("## Authorization"), readme.indexOf("\n## ", readme.indexOf("## Authorization")));
    const rows = [...section.matchAll(/^\| `(\w+)` \| `(\w+)` \|(.*)\|$/gm)].map(
      ([, kind, action, cells]) => [`${kind}.${action}`, cells.split("|").map((cell) => cell.trim() === "✓")],
    );
    expect(Object.fromEntries(rows)).toEqual(actualTable());
  });

  test("every rule is upward closed", () => {
    for (const [key, row] of Object.entries(actualTable())) {
      const first = row.indexOf(true);
      expect(first, key).toBeGreaterThanOrEqual(0);
      expect(row.slice(first).every(Boolean), key).toBe(true);
    }
  });

  test("withinPolicy reads the request's kind, action and principal role", () => {
    const project = { kind: "project", projectId: "p1" } as const;
    const principal = (role: Role) => ({ id: "u1", role });
    expect(withinPolicy({ principal: principal("editor"), workspaceId: "ws1", resource: project, action: "update_asset" })).toBe(true);
    expect(withinPolicy({ principal: principal("viewer"), workspaceId: "ws1", resource: project, action: "create_asset" })).toBe(false);
    expect(withinPolicy({ principal: principal("admin"), workspaceId: "ws1", resource: project, action: "delete" })).toBe(false);
    expect(withinPolicy({ principal: principal("admin"), workspaceId: "ws1", resource: { kind: "workspace" }, action: "manage_members" })).toBe(true);
    expect(withinPolicy({ principal: principal("admin"), workspaceId: "ws1", resource: { kind: "workspace" }, action: "delete" })).toBe(false);
  });

  test("a project request cannot carry a workspace action", () => {
    const principal = { id: "u1", role: "owner" } as const;
    const resource = { kind: "project", projectId: "p1" } as const;
    // @ts-expect-error
    const req: AuthzRequest = { principal, workspaceId: "ws1", resource, action: "manage_members" };
    expect(req.resource.kind).toBe("project");
  });

  test("canManageRole blocks acting above one's own role", () => {
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("admin", "admin")).toBe(true);
    expect(canManageRole("admin", "viewer")).toBe(true);
    expect(canManageRole("owner", "owner")).toBe(true);
    expect(canManageRole("editor", "admin")).toBe(false);
  });

  test("docs/examples/cerbos grants each action to exactly the roles POLICY allows", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const { z } = await import("zod");
    const { roleSchema } = await import("../../shared/api");

    const cerbosPolicy = z.strictObject({
      apiVersion: z.literal("api.cerbos.dev/v1"),
      resourcePolicy: z.strictObject({
        resource: z.string(),
        version: z.literal("default"),
        rules: z.array(z.strictObject({
          actions: z.array(z.string()).nonempty(),
          effect: z.literal("EFFECT_ALLOW"),
          roles: z.array(roleSchema).nonempty(),
        })),
      }),
    });

    const fromYaml: string[] = [];
    for (const kind of ["workspace", "project"] satisfies ResourceKind[]) {
      const url = new URL(`../../docs/examples/cerbos/${kind}.yaml`, import.meta.url);
      const { resourcePolicy } = cerbosPolicy.parse(parse(await readFile(url, "utf8")));
      expect(resourcePolicy.resource).toBe(kind);
      for (const rule of resourcePolicy.rules) {
        const minimum = LADDER.find((role) => rule.roles.includes(role))!;
        expect([...rule.roles].sort(), `${kind} ${rule.actions.join(",")}`).toEqual(
          LADDER.slice(LADDER.indexOf(minimum)).sort(),
        );
        for (const action of rule.actions) fromYaml.push(`${kind}.${action}:${minimum}`);
      }
    }
    expect(fromYaml.sort()).toEqual(policyEntries().map((e) => `${e.kind}.${e.action}:${e.minimum}`).sort());
  });
}
