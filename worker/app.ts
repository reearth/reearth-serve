import { Hono } from "hono";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { jobRoutes, jobInternalRoutes } from "./job/handler";
import { R2FileStorage } from "./infra/storage";
import {
  KVMetadataStore, KVUploadSessionStore, KVJobStore, KVProjectStore,
  KVWorkspaceStore, KVMemberStore, KVSessionStore,
} from "./infra/metadata";
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
  const metadata = new KVMetadataStore(env.KV);
  const storage = new R2FileStorage(env.STORAGE);
  const uploadSessions = new KVUploadSessionStore(env.KV);
  const jobs = new KVJobStore(env.KV);
  const projects = new KVProjectStore(env.KV);
  const workspaces = new KVWorkspaceStore(env.KV);
  const memberStore = new KVMemberStore(env.KV);
  const sessions = new KVSessionStore(env.KV);
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

  const app = new Hono<AppEnv>();

  // Authentication middleware (with KV-backed JWKS cache)
  app.use("*", authMiddleware(env));

  // Anonymous session tracking (for unauthenticated users)
  app.use("*", sessionMiddleware(sessions, ttlSeconds));

  // Inject dependencies into all routes
  app.use("*", async (c, next) => {
    c.set("metadata", metadata);
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
    await next();
  });

  // Public API (versioned)
  app.get("/api/v1/health", (c) => c.json({ ok: true }));
  app.route("/api/v1/assets", assetRoutes);
  app.route("/api/v1/jobs", jobRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/api/v1/projects", projectRoutes);
  app.route("/api/v1/workspaces", workspaceRoutes);

  // Internal API (no versioning, no compatibility guarantee)
  app.route("/api/internal/jobs", jobInternalRoutes);

  // File delivery (not behind /api — permalink URLs)
  app.route("/files", fileRoutes);

  return app;
}
