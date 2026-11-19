import type { Role } from "../../shared/api";

const REDACTED = "[redacted]";

export class BearerCredential {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  reveal(): string {
    return this.#token;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export type VerifiedCaller = {
  kind: "user";
  sub: string;
  email?: string;
  name?: string;
  credential: BearerCredential;
};

export interface AuthUser {
  id: string;
  sub: string;
  email?: string;
  name?: string;
}

export const SERVICE_ROLES = ["viewer", "editor"] as const satisfies readonly Role[];
export type ServiceRole = (typeof SERVICE_ROLES)[number];

export function isServiceRole(role: string): role is ServiceRole {
  return (SERVICE_ROLES as readonly string[]).includes(role);
}

/**
 * A role on exactly one project, optionally narrowed to one bucket of it.
 * `bucket: null` reaches the whole project, as ADR-016 decision 11 service
 * clients would.
 */
export type ProjectGrant = { projectId: string; bucket: string | null; role: ServiceRole };

export type ServicePrincipal = {
  kind: "service";
  id: string;
  grant: ProjectGrant;
  revokedAt: number | null;
};

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const { inspect } = await import("node:util");

  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-payload.signature";
  const caller: VerifiedCaller = { kind: "user", sub: "u1", credential: new BearerCredential(TOKEN) };

  test.each([
    ["JSON.stringify", () => JSON.stringify(caller)],
    ["a template string", () => `${caller.credential}`],
    ["String()", () => String(caller.credential)],
    ["util.inspect of the credential", () => inspect(caller.credential)],
    ["util.inspect of the caller", () => inspect(caller, { depth: 5 })],
  ])("%s prints no token text", (_, render) => {
    const out = render();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("secret-payload");
    expect(out).toContain(REDACTED);
  });

  test("JSON.stringify shows the credential as redacted", () => {
    expect(JSON.stringify(caller)).toContain(`"credential":"${REDACTED}"`);
  });

  test("reveal returns the token", () => {
    expect(caller.credential.reveal()).toBe(TOKEN);
  });
}
