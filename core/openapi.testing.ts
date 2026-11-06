import type { Deps } from "./types";
import type { Session, SessionStore } from "./session/repository";

// Test helper for the OpenAPI tests (core/openapi.test.ts,
// core/openapi-components.test.ts).

class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async find(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
}

/** Only what serving /api/v1/doc touches; anything else throws if called. */
export function docOnlyDeps(): Deps {
  const unused = new Proxy({}, {
    get(_, name) {
      throw new Error(`fake dependency "${String(name)}" was called unexpectedly`);
    },
  });
  return new Proxy(
    {
      sessions: new MemorySessionStore(),
      sessionTtlSeconds: 60,
      auth: {},
      anonymousUploadEnabled: false,
    } as Partial<Deps>,
    { get: (target, key: string) => (key in target ? target[key as keyof Deps] : unused) },
  ) as Deps;
}
