/**
 * The shared fixture (`./fixture.ts`) upgraded into a project world, for the
 * site-host suites (ADR-013 Part B).
 *
 * Claiming a name needs an authenticated member of the asset's project, which
 * is three fakes and a signed token more than the delivery tests need. It
 * lives here rather than inside one suite because B2/B3/B4 and B5 both build
 * on it, and two copies would drift.
 */

import { SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Role } from "../../shared/api";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import type { Member } from "../member/model";
import type { MemberStore } from "../member/repository";
import type { Deps } from "../types";
import { ASSET_ID, fixture, SINGLE_FILE_ID } from "./fixture";

export const SUFFIX = ".serve.example.test";
export const PROJECT_ID = "p1";
export const WORKSPACE_ID = "ws1";
export const USER = "u1";
export const ISSUER = "https://issuer.example.test/";
export const AUDIENCE = "test-audience";
const SECRET = new TextEncoder().encode("a-test-secret-that-is-long-enough-32");

export class MemoryProjectStore implements ProjectStore {
  readonly projects = new Map<string, Project>();
  async save(project: Project): Promise<void> { this.projects.set(project.id, project); }
  async find(id: string): Promise<Project | null> { return this.projects.get(id) ?? null; }
  async list(): Promise<Project[]> { return [...this.projects.values()]; }
  async delete(id: string): Promise<void> { this.projects.delete(id); }
}

export class MemoryMemberStore implements MemberStore {
  readonly members = new Map<string, Member>();
  async save(member: Member): Promise<void> { this.members.set(`${member.workspaceId}:${member.userId}`, member); }
  async find(workspaceId: string, userId: string): Promise<Member | null> {
    return this.members.get(`${workspaceId}:${userId}`) ?? null;
  }
  async list(): Promise<Member[]> { return [...this.members.values()]; }
  async listByUser(): Promise<Member[]> { return [...this.members.values()]; }
  async delete(): Promise<void> {}
}

export async function token(sub = USER): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(sub)
    .setExpirationTime("1h")
    .sign(SECRET);
}

export interface SiteFixtureOptions {
  role?: Role;
  suffix?: string | undefined;
  /** Passed through to the underlying fixture (a throwing store, a fake DNS…). */
  deps?: Partial<Deps>;
}

/**
 * The archive asset belongs to a project in a workspace the caller is a member
 * of, with `role` deciding what they may do.
 */
export async function siteFixture(options: SiteFixtureOptions = {}) {
  const projects = new MemoryProjectStore();
  const members = new MemoryMemberStore();
  await projects.save({
    id: PROJECT_ID, name: "P", createdAt: 0, updatedAt: 0,
    ownerId: "someone-else", workspaceId: WORKSPACE_ID,
  });
  await members.save({
    workspaceId: WORKSPACE_ID, userId: USER,
    role: options.role ?? "editor", createdAt: 0, updatedAt: 0,
  });

  const f = await fixture({
    siteHostSuffix: "suffix" in options ? options.suffix : SUFFIX,
    projects,
    members,
    // Deleting a project asset moves the storage counters.
    storageUsage: {
      async get() { return null; },
      async increment() {},
      async decrement() {},
      async recalculate() {},
    },
    auth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      // A local verifier instead of a JWKS fetch; the middleware's contract is
      // the same either way.
      jwks: (async () => SECRET) as unknown as JWTVerifyGetKey,
    },
    ...options.deps,
  });

  // Both seeded assets become project assets; the single-file one stays
  // single-file, which is the "not an archive" case.
  for (const id of [ASSET_ID, SINGLE_FILE_ID]) {
    const asset = f.metadata.assets.get(id)!;
    f.metadata.assets.set(id, { ...asset, projectId: PROJECT_ID });
  }

  const auth = { Authorization: `Bearer ${await token()}` };
  return { ...f, projects, members, auth };
}

export type SiteApp = Awaited<ReturnType<typeof siteFixture>>["app"];
