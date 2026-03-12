import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types";
import type { SessionStore } from "./repository";

/**
 * Session middleware for anonymous user tracking.
 *
 * - If user is authenticated (c.get("user") is set), sessionId = null.
 * - If X-Session-Id header is present and valid, reuse it.
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
      // Validate existing session
      const existing = await sessions.find(headerSessionId);
      if (existing) {
        c.set("sessionId", headerSessionId);
        return next();
      }
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
