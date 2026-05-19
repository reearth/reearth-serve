import { createRequestHandler } from "react-router";
import { createApp } from "./app";
import { handleScheduled } from "./cleanup/handler";
import { handleQueue } from "./extraction/handler";
import { handleThumbnailQueue } from "./thumbnail/handler";

export { ArchiveExtractorContainer, ThumbnailContainer } from "./infra/container";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes: /api/*, /files/*
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/files")
    ) {
      const app = createApp(env);
      return app.fetch(request, env, ctx);
    }

    // Everything else: React Router SSR (UI)
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },

  async scheduled(_event, env, _ctx) {
    await handleScheduled(env);
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext) {
    if (batch.queue === "reearth-serve-thumbnail") {
      await handleThumbnailQueue(batch as MessageBatch<import("./thumbnail/queue").ThumbnailMessage>, env);
      return;
    }
    // Default: extraction queue (covers the original single-queue deployment
    // where batch.queue may be undefined under older wrangler builds).
    await handleQueue(batch as MessageBatch<import("./extraction/handler").ExtractionMessage>, env);
  },
} satisfies ExportedHandler<Env>;
