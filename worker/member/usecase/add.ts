import type { Member, Role } from "../../../shared/api";
import type { MemberStore } from "../repository";

export async function addMember(
  members: MemberStore,
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<Member> {
  const existing = await members.find(workspaceId, userId);
  if (existing) {
    throw new Error("Member already exists");
  }

  const now = Date.now();
  const member: Member = { workspaceId, userId, role, createdAt: now, updatedAt: now };
  await members.save(member);
  return member;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  test("addMember creates a new member", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => null),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    const member = await addMember(ms, "ws1", "user-2", "editor");
    expect(member.workspaceId).toBe("ws1");
    expect(member.userId).toBe("user-2");
    expect(member.role).toBe("editor");
    expect(ms.save).toHaveBeenCalledOnce();
  });

  test("addMember throws if member already exists", async () => {
    const ms: MemberStore = {
      save: vi.fn(async () => {}),
      find: vi.fn(async () => ({
        workspaceId: "ws1", userId: "user-2", role: "editor" as const, createdAt: 0, updatedAt: 0,
      })),
      list: vi.fn(async () => []),
      listByUser: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };

    await expect(addMember(ms, "ws1", "user-2", "editor")).rejects.toThrow("Member already exists");
  });
}
