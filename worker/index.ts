import { createRequestHandler } from "react-router";
import { createApp } from "./app";

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

    // API routes: /health, /assets/*, /files/*, /jobs/*
    if (
      url.pathname === "/health" ||
      url.pathname.startsWith("/assets") ||
      url.pathname.startsWith("/files") ||
      url.pathname.startsWith("/jobs")
    ) {
      const app = createApp(env);
      return app.fetch(request, env, ctx);
    }

    // Everything else: React Router SSR (UI)
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
