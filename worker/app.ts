import { Hono } from "hono";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { jobRoutes } from "./job/handler";
import { R2FileStorage } from "./infra/storage";
import { KVMetadataStore, KVUploadSessionStore, KVJobStore } from "./infra/metadata";
import { R2PresignedUrlGenerator } from "./infra/presigned";
import type { AppEnv } from "./types";

export function createApp(env: Env) {
  const metadata = new KVMetadataStore(env.KV);
  const storage = new R2FileStorage(env.STORAGE);
  const uploadSessions = new KVUploadSessionStore(env.KV);
  const jobs = new KVJobStore(env.KV);
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

  const app = new Hono<AppEnv>();

  // Inject dependencies into all routes
  app.use("*", async (c, next) => {
    c.set("metadata", metadata);
    c.set("storage", storage);
    c.set("uploadSessions", uploadSessions);
    c.set("presignedUrls", presignedUrls);
    c.set("jobs", jobs);
    c.set("ttlSeconds", ttlSeconds);
    c.set("baseUrl", baseUrl);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/assets", assetRoutes);
  app.route("/files", fileRoutes);
  app.route("/jobs", jobRoutes);

  return app;
}
