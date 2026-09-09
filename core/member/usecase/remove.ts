import type { MemberStore } from "../repository";

export async function removeMember(
  members: MemberStore,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const existing = await members.find(workspaceId, userId);
  if (!existing) return false;

  // Cannot remove the last owner
  if (existing.role === "owner") {
    const allMembers = await members.list(workspaceId);
    const ownerCount = allMembers.filter((m) => m.role === "owner").length;
    if (ownerCount <= 1) {
      throw new Error("Cannot remove the last owner");
    }
  }

  await members.delete(workspaceId, userId);
  return true;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  test("removeMember removes existing member", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => ({
        workspaceId: "ws1", userId: "u2", role: "editor" as const, createdAt: 0, updatedAt: 0,
      })),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    expect(await removeMember(ms, "ws1", "u2")).toBe(true);
    expect(ms.delete).toHaveBeenCalledWith("ws1", "u2");
  });

  test("removeMember returns false for non-existent member", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    expect(await removeMember(ms, "ws1", "nope")).toBe(false);
  });

  test("removeMember throws when removing last owner", async () => {
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

    await expect(removeMember(ms, "ws1", "u1")).rejects.toThrow("Cannot remove the last owner");
  });
}
