import { Hono, type Context, type MiddlewareHandler } from "hono";
import { openAPIRouteHandler } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { jobRoutes, jobInternalRoutes } from "./job/handler";
import { R2FileStorage } from "./infra/storage";
import {
  KVUploadSessionStore, KVSessionStore,
} from "./infra/metadata";
import {
  D1MetadataStore, D1JobStore, D1ProjectStore,
  D1WorkspaceStore, D1MemberStore, D1StorageUsageStore, D1VersionStore,
  D1CleanupPendingStore,
} from "./infra/d1";
import { projectRoutes } from "./project/handler";
import { workspaceRoutes } from "./workspace/handler";
import { meRoutes } from "./me/handler";
import { R2PresignedUrlGenerator } from "./infra/presigned";
import { authMiddleware } from "./auth/middleware";
import { CerbosAuthorizer } from "./auth/authorizer";
import { sessionMiddleware } from "./session/middleware";
import { SimpleAuthorizer } from "./infra/authorizer";
import type { AppEnv } from "./types";

export function createApp(env: Env) {
  const metadata = new D1MetadataStore(env.DB);
  const versions = new D1VersionStore(env.DB);
  const storage = new R2FileStorage(env.STORAGE);
  const uploadSessions = new KVUploadSessionStore(env.KV);
  const jobs = new D1JobStore(env.DB);
  const projects = new D1ProjectStore(env.DB);
  const workspaces = new D1WorkspaceStore(env.DB);
  const memberStore = new D1MemberStore(env.DB);
  const sessions = new KVSessionStore(env.KV);
  const storageUsage = new D1StorageUsageStore(env.DB);
  const pendingCleanup = new D1CleanupPendingStore(env.DB);
  const authorizer = env.CERBOS_ENDPOINT
    ? new CerbosAuthorizer(env.CERBOS_ENDPOINT)
    : new SimpleAuthorizer();
  const ttlSeconds = parseInt(env.ASSET_TTL_SECONDS, 10) || 3600;
  const baseUrl = env.BASE_URL;

  const presignedUrls = (env.R2_S3_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)
    ? new R2PresignedUrlGenerator({
        endpoint: env.R2_S3_ENDPOINT,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET_NAME || "reearth-serve",
      })
    : null;

  const extractionQueue = env.EXTRACTION_QUEUE ?? null;
  // Default: anonymous uploads enabled. Only "false" disables — typo-tolerant.
  const anonymousUploadEnabled = env.ANONYMOUS_UPLOAD_ENABLED !== "false";

  const app = new Hono<AppEnv>();

  // Authentication middleware (with KV-backed JWKS cache)
  app.use("*", authMiddleware(env));

  // Anonymous session tracking (for unauthenticated users)
  app.use("*", sessionMiddleware(sessions, ttlSeconds));

  // Inject dependencies into all routes
  app.use("*", async (c, next) => {
    c.set("metadata", metadata);
    c.set("versions", versions);
    c.set("storage", storage);
    c.set("uploadSessions", uploadSessions);
    c.set("presignedUrls", presignedUrls);
    c.set("jobs", jobs);
    c.set("ttlSeconds", ttlSeconds);
    c.set("baseUrl", baseUrl);
    c.set("authorizer", authorizer);
    c.set("projects", projects);
    c.set("workspaces", workspaces);
    c.set("members", memberStore);
    c.set("extractionQueue", extractionQueue);
    c.set("storageUsage", storageUsage);
    c.set("pendingCleanup", pendingCleanup);
    c.set("anonymousUploadEnabled", anonymousUploadEnabled);
    await next();
  });

  // Public API (versioned)
  app.get("/api/v1/health", (c) => c.json({ ok: true, anonymousUploadEnabled }));
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
  app.use("/api/internal/*", internalApiAuth(env.INTERNAL_API_SECRET));
  app.route("/api/internal/jobs", jobInternalRoutes);

  // Internal asset existence check (for container TTL checks)
  app.get("/api/internal/assets/:id/exists", async (c) => {
    const asset = await metadata.find(c.req.param("id"));
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
