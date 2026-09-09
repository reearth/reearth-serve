import { Hono, type Context, type MiddlewareHandler } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { jobRoutes, jobInternalRoutes } from "./job/handler";
import { projectRoutes } from "./project/handler";
import { workspaceRoutes } from "./workspace/handler";
import { meRoutes } from "./me/handler";
import { authMiddleware } from "./auth/middleware";
import { sessionMiddleware } from "./session/middleware";
import type { AppEnv, Deps } from "./types";

/**
 * Builds the HTTP application from an already-assembled dependency set.
 *
 * `createApp` knows nothing about Cloudflare (or any other provider): the
 * env-to-adapter wiring lives in a composition root such as
 * `infra/cloudflare-deps.ts` (ADR-012 §1).
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Authentication middleware (JWKS cache comes from deps)
  app.use("*", authMiddleware(deps.auth));

  // Anonymous session tracking (for unauthenticated users)
  app.use("*", sessionMiddleware(deps.sessions, deps.sessionTtlSeconds));

  // Inject dependencies into all routes
  app.use("*", async (c, next) => {
    c.set("metadata", deps.metadata);
    c.set("versions", deps.versions);
    c.set("storage", deps.storage);
    c.set("uploadSessions", deps.uploadSessions);
    c.set("presignedUrls", deps.presignedUrls);
    c.set("jobs", deps.jobs);
    c.set("ttlSeconds", deps.ttlSeconds);
    c.set("baseUrl", deps.baseUrl);
    c.set("authorizer", deps.authorizer);
    c.set("projects", deps.projects);
    c.set("workspaces", deps.workspaces);
    c.set("members", deps.members);
    c.set("extractionQueue", deps.extractionQueue);
    c.set("thumbnailQueue", deps.thumbnailQueue);
    c.set("storageUsage", deps.storageUsage);
    c.set("pendingCleanup", deps.pendingCleanup);
    c.set("anonymousUploadEnabled", deps.anonymousUploadEnabled);
    await next();
  });

  // Public API (versioned)
  app.get("/api/v1/health", (c) => c.json({ ok: true, anonymousUploadEnabled: deps.anonymousUploadEnabled }));
  app.route("/api/v1/assets", assetRoutes);
  app.route("/api/v1/jobs", jobRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/api/v1/projects", projectRoutes);
  app.route("/api/v1/workspaces", workspaceRoutes);

  // Internal API (no versioning, no compatibility guarantee).
  // Requires shared secret — these routes mutate job/asset state from the
  // extraction container, so they must never be reachable from public callers.
  // Asset IDs are embedded in public file URLs, so without auth an attacker
  // who sees a permalink could mark the victim's job failed or "complete"
  // with bogus metadata.
  app.use("/api/internal/*", internalApiAuth(deps.internalApiSecret));
  app.route("/api/internal/jobs", jobInternalRoutes);

  // Internal asset existence check (for container TTL checks)
  app.get("/api/internal/assets/:id/exists", async (c) => {
    const asset = await deps.metadata.find(c.req.param("id"));
    return asset ? c.json({ exists: true }) : c.json({ exists: false }, 404);
  });

  // File delivery (not behind /api — permalink URLs)
  app.route("/files", fileRoutes);

  // OpenAPI spec + Scalar UI
  app.get("/api/v1/doc", openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Re:Earth Serve API",
        version: "1.0.0",
        description: "Spatial Data Delivery API",
      },
      servers: [{ url: "/" }],
      tags: [
        { name: "Assets", description: "Asset upload, metadata, and management" },
        { name: "Jobs", description: "Background job tracking" },
        { name: "Projects", description: "Project management" },
        { name: "Workspaces", description: "Workspace and member management" },
        { name: "Auth", description: "Authentication and user info" },
      ],
    },
  }));

  app.get("/api/v1/docs", Scalar({ url: "/api/v1/doc" }));

  return app;
}

/**
 * Constant-time comparison so secret validation doesn't leak length/contents
 * via timing differences. Returns false on any length mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function internalApiAuth(expected: string | undefined): MiddlewareHandler {
  return async (c: Context, next) => {
    if (!expected) {
      // Fail closed: without a configured secret the internal API is unsafe
      // to expose at all, so refuse every request rather than authenticate
      // nothing.
      return c.json({ error: "Internal API not configured" }, 503);
    }
    const header = c.req.header("Authorization") ?? "";
    const m = header.match(/^Bearer\s+(.+)$/);
    if (!m || !timingSafeEqual(m[1], expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
