import type { Member, Role } from "../../../shared/api";
import type { MemberStore } from "../repository";

export async function updateMemberRole(
  members: MemberStore,
  workspaceId: string,
  userId: string,
  newRole: Role,
): Promise<Member | null> {
  const existing = await members.find(workspaceId, userId);
  if (!existing) return null;

  // Cannot demote the last owner
  if (existing.role === "owner" && newRole !== "owner") {
    const allMembers = await members.list(workspaceId);
    const ownerCount = allMembers.filter((m) => m.role === "owner").length;
    if (ownerCount <= 1) {
      throw new Error("Cannot demote the last owner");
    }
  }

  const updated: Member = { ...existing, role: newRole, updatedAt: Date.now() };
  await members.save(updated);
  return updated;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  test("updateMemberRole updates role", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => ({
        workspaceId: "ws1", userId: "u2", role: "editor" as const, createdAt: 0, updatedAt: 0,
      })),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    const result = await updateMemberRole(ms, "ws1", "u2", "admin");
    expect(result?.role).toBe("admin");
    expect(ms.save).toHaveBeenCalledOnce();
  });

  test("updateMemberRole returns null for non-existent member", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    expect(await updateMemberRole(ms, "ws1", "nope", "admin")).toBeNull();
  });

  test("updateMemberRole throws when demoting last owner", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => ({
        workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 0, updatedAt: 0,
      })),
      list: vi.fn(async () => [
        { workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 0, updatedAt: 0 },
      ]),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    await expect(updateMemberRole(ms, "ws1", "u1", "admin")).rejects.toThrow("Cannot demote the last owner");
  });
}
