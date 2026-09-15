import { createRequestHandler } from "react-router";
import { createApp } from "../../core/app";
import { buildDeps } from "../../adapters/cloudflare/cloudflare-deps";
import { isSiteHost } from "../../core/site/middleware";
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

    // API routes: /api/*, /files/* — plus every path on a site host, whose
    // whole surface is file delivery (ADR-013 B1). Without the host check the
    // React Router UI would answer at `{assetId}.serve.reearth.land/`.
    //
    // Since B5 the host test is "not the apex" rather than "ends with
    // SITE_HOST_SUFFIX": a customer's own domain looks like any other
    // hostname, so it cannot be recognised here — only a `site_hosts` lookup
    // can, and that lookup lives in the app's middleware. Handing every
    // non-apex host to the app costs an unknown hostname the middleware's
    // plain-text 404 instead of the UI, which is the right answer anyway: a
    // domain somebody pointed at us must not serve the dashboard. The UI, the
    // API, the docs and the health check remain reachable on the apex only.
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/files") ||
      isSiteHost(request.headers.get("Host") ?? url.host, {
        baseUrl: env.BASE_URL,
        suffix: env.SITE_HOST_SUFFIX,
      })
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
