import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import type { SessionStore } from "./repository";

// 16-char hex string (generated from UUID without hyphens)
const SESSION_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Session middleware for anonymous user tracking.
 *
 * - If user is authenticated (c.get("user") is set), sessionId = null.
 * - If X-Session-Id header is present and valid format, reuse it (create in KV if new).
 * - If X-Session-Id has invalid format, return 401.
 * - Otherwise, generate a new session ID and return it in the response header.
 */
export function sessionMiddleware(sessions: SessionStore, ttlSeconds: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Authenticated users don't need anonymous sessions
    const user = c.get("user");
    if (user) {
      c.set("sessionId", null);
      return next();
    }

    const headerSessionId = c.req.header("X-Session-Id");

    if (headerSessionId) {
      // Validate format
      if (!SESSION_ID_PATTERN.test(headerSessionId)) {
        return c.json({ error: "Invalid session ID format" }, 401);
      }

      // Accept client-generated session IDs; create in KV if not exists
      const existing = await sessions.find(headerSessionId);
      if (!existing) {
        const now = Date.now();
        await sessions.save(
          { id: headerSessionId, createdAt: now, expiresAt: now + ttlSeconds * 1000 },
          ttlSeconds,
        );
      }

      c.set("sessionId", headerSessionId);
      return next();
    }

    // Generate new session
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();
    await sessions.save(
      { id, createdAt: now, expiresAt: now + ttlSeconds * 1000 },
      ttlSeconds,
    );

    c.set("sessionId", id);
    c.header("X-Session-Id", id);

    return next();
  });
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;
  const { Hono } = await import("hono");

  type Session = import("./repository").Session;

  function mockSessions() {
    const store = new Map<string, Session>();
    return {
      store,
      save: vi.fn(async (s: Session) => { store.set(s.id, s); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
    };
  }

  function createApp(sessions: ReturnType<typeof mockSessions>, authUser?: string) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", authUser ? { sub: authUser } : null);
      return next();
    });
    app.use("*", sessionMiddleware(sessions, 3600));
    app.get("/test", (c) => c.json({ sessionId: c.get("sessionId") }));
    return app;
  }

  test("no X-Session-Id → generates new session and returns in header", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions);
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(res.headers.get("X-Session-Id")).toBe(body.sessionId);
    expect(sessions.save).toHaveBeenCalledOnce();
  });

  test("valid X-Session-Id (existing in KV) → reuses session", async () => {
    const sessions = mockSessions();
    sessions.store.set("abcdef0123456789", { id: "abcdef0123456789", createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
    const app = createApp(sessions);
    const res = await app.request("/test", { headers: { "X-Session-Id": "abcdef0123456789" } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).sessionId).toBe("abcdef0123456789");
    expect(sessions.save).not.toHaveBeenCalled();
  });

  test("valid X-Session-Id (not in KV) → creates and accepts", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions);
    const res = await app.request("/test", { headers: { "X-Session-Id": "1234567890abcdef" } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).sessionId).toBe("1234567890abcdef");
    expect(sessions.save).toHaveBeenCalledOnce();
  });

  test("invalid X-Session-Id format (too short) → 401", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions);
    const res = await app.request("/test", { headers: { "X-Session-Id": "abc" } });
    expect(res.status).toBe(401);
  });

  test("invalid X-Session-Id format (uppercase) → 401", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions);
    const res = await app.request("/test", { headers: { "X-Session-Id": "ABCDEF0123456789" } });
    expect(res.status).toBe(401);
  });

  test("invalid X-Session-Id format (too long) → 401", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions);
    const res = await app.request("/test", { headers: { "X-Session-Id": "abcdef0123456789extra" } });
    expect(res.status).toBe(401);
  });

  test("authenticated user → sessionId is null, no session created", async () => {
    const sessions = mockSessions();
    const app = createApp(sessions, "user-1");
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect((await res.json() as any).sessionId).toBeNull();
    expect(sessions.save).not.toHaveBeenCalled();
  });
}
