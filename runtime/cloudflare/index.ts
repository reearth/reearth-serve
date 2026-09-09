import { createRequestHandler } from "react-router";
import { createApp } from "../../core/app";
import { buildDeps } from "../../adapters/cloudflare/cloudflare-deps";
import { handleScheduled } from "../../core/cleanup/handler";
import { handleQueue } from "../../core/extraction/handler";
import { handleThumbnailQueue } from "../../core/thumbnail/handler";
import { toQueueMessages } from "../../adapters/cloudflare/queues";

export { ArchiveExtractorContainer, ThumbnailContainer } from "../../adapters/cloudflare/container";

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
      const app = createApp(buildDeps(env));
      return app.fetch(request, env, ctx);
    }

    // Everything else: React Router SSR (UI)
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },

  async scheduled(_event, env, _ctx) {
    await handleScheduled(buildDeps(env));
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext) {
    const deps = buildDeps(env);
    if (batch.queue === "reearth-serve-thumbnail") {
      await handleThumbnailQueue(
        toQueueMessages(batch as MessageBatch<import("../../core/thumbnail/queue").ThumbnailMessage>),
        deps,
      );
      return;
    }
    // Default: extraction queue (covers the original single-queue deployment
    // where batch.queue may be undefined under older wrangler builds).
    await handleQueue(
      toQueueMessages(batch as MessageBatch<import("../../core/extraction/handler").ExtractionMessage>),
      deps,
    );
  },
} satisfies ExportedHandler<Env>;
