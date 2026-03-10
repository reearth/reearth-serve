import { Hono } from "hono";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { R2FileStorage } from "./infra/storage";
import { KVMetadataStore } from "./infra/metadata";
import type { AppEnv } from "./types";

export function createApp(env: Env) {
  const metadata = new KVMetadataStore(env.KV);
  const storage = new R2FileStorage(env.STORAGE);
  const ttlSeconds = parseInt(env.ASSET_TTL_SECONDS, 10) || 3600;
  const baseUrl = env.BASE_URL;

  const app = new Hono<AppEnv>();

  // Inject dependencies into all routes
  app.use("*", async (c, next) => {
    c.set("metadata", metadata);
    c.set("storage", storage);
    c.set("ttlSeconds", ttlSeconds);
    c.set("baseUrl", baseUrl);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/assets", assetRoutes);
  app.route("/files", fileRoutes);

  return app;
}
