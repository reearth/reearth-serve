import type { Authorizer } from "../../core/auth/authorizer";
import type { AuthUser, VerifiedCaller } from "../../core/auth/types";
import type { SqlClient } from "../../core/sql/port";
import type { Tenancy, TenantScope } from "../../core/tenancy/port";
import { SqlMemberStore, SqlWorkspaceStore } from "./stores";

export class LocalTenancy implements Tenancy {
  private readonly workspaces: SqlWorkspaceStore;

  constructor(private readonly sql: SqlClient, private readonly authorizer: Authorizer) {
    this.workspaces = new SqlWorkspaceStore(sql);
  }

  async enter(caller: VerifiedCaller | null): Promise<{ user: AuthUser | null; scope: TenantScope }> {
    const user = caller && { id: caller.sub, sub: caller.sub, email: caller.email, name: caller.name };
    const members = new SqlMemberStore(this.sql, user?.id ?? null);
    return {
      user,
      scope: {
        workspaces: this.workspaces,
        members,
        authorizer: this.authorizer,
        admin: { workspaces: this.workspaces, members },
      },
    };
  }
}

if (import.meta.vitest) {
  const { test, expect, describe } = import.meta.vitest;
  const { createSqliteClient } = await import("../memory/sqlite-node");
  const { SimpleAuthorizer } = await import("../../core/auth/permissions");
  const { BearerCredential } = await import("../../core/auth/types");

  const caller: VerifiedCaller = {
    kind: "user", sub: "u1", email: "u1@example.test", name: "U1", credential: new BearerCredential("t"),
  };

  async function seeded(memberships: number) {
    const sql = createSqliteClient();
    const writer = new SqlMemberStore(sql, null);
    for (let i = 0; i < memberships; i++) {
      await writer.save({ workspaceId: `ws${i}`, userId: "u1", role: "viewer", createdAt: i, updatedAt: i });
    }
    await writer.save({ workspaceId: "ws0", userId: "u2", role: "owner", createdAt: 0, updatedAt: 0 });
    return new LocalTenancy(sql, new SimpleAuthorizer());
  }

  describe("LocalTenancy", () => {
    test("enter(null) has no user and no memberships to list", async () => {
      const { user, scope } = await (await seeded(1)).enter(null);
      expect(user).toBeNull();
      expect(await scope.members.listForCaller()).toEqual([]);
    });

    test("enter(caller) keys the directory user by sub and keeps the profile", async () => {
      const { user } = await (await seeded(0)).enter(caller);
      expect(user).toEqual({ id: "u1", sub: "u1", email: "u1@example.test", name: "U1" });
    });

    test("listForCaller returns only the caller's memberships, past the old 200-row cap", async () => {
      const { scope } = await (await seeded(250)).enter(caller);
      const mine = await scope.members.listForCaller();
      expect(mine).toHaveLength(250);
      expect(mine.every((m) => m.userId === "u1")).toBe(true);
    });

    test("the local directory owns membership, so writes are available", async () => {
      const { scope } = await (await seeded(0)).enter(caller);
      expect(scope.admin).not.toBeNull();
    });
  });
}
