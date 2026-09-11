/**
 * Node runtime: the API and file delivery, on a plain Node process (ADR-012 §5).
 *
 * It serves `/api/*` and `/files/*` from the very same `createApp(deps)` the
 * Worker serves, plus one operational endpoint, `POST /internal/cron`. The
 * React Router UI is **not** served here — SSR on Node is out of scope, and
 * anything outside the two API prefixes returns 404 saying so.
 *
 * Start it with `npm run start:node` (tsx). Configuration is environment
 * variables only; see `config.ts` and the README's "Running on Node" section.
 */
import { serve } from "@hono/node-server";
import { createApp } from "../../core/app";
import { isSiteHost } from "../../core/site/middleware";
import { buildNodeRuntime, type NodeRuntime } from "./deps";
import { runCron } from "./cron";

export function createNodeHandler(runtime: NodeRuntime): (request: Request) => Promise<Response> {
  const app = createApp(runtime.deps);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Site hosts (ADR-013 B1) serve files at every path, so they are decided
    // before the API-only guard below — and before /internal/cron, which must
    // not be reachable from a hosted origin.
    if (isSiteHost(request.headers.get("Host") ?? url.host, runtime.deps.siteHostSuffix)) {
      return app.fetch(request);
    }

    if (url.pathname === "/internal/cron") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      return cron(request, runtime);
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/files")) {
      return app.fetch(request);
    }

    return json(
      {
        error: "Not found",
        detail: "This runtime serves the API only (/api/*, /files/*); the UI is not served here.",
      },
      404,
    );
  };
}

async function cron(request: Request, runtime: NodeRuntime): Promise<Response> {
  const expected = runtime.deps.internalApiSecret;
  if (!expected) {
    // Same fail-closed rule as /api/internal/*: no secret, no endpoint.
    return json({ error: "Internal API not configured" }, 503);
  }
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!match || !timingSafeEqual(match[1], expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    return json(await runCron(runtime));
  } catch (e) {
    console.error("Cron failed:", e);
    return json({ error: "Cron failed" }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time compare, mirroring the one guarding /api/internal/*. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function main(): void {
  const runtime = buildNodeRuntime();
  const handler = createNodeHandler(runtime);
  serve({ fetch: handler, port: runtime.config.port }, (info) => {
    console.log(`reearth-serve (node runtime) listening on http://localhost:${info.port}`);
    console.log(`  base URL:  ${runtime.config.baseUrl}`);
    console.log(`  sqlite:    ${runtime.config.sqlitePath}`);
    console.log(`  API only:  /api/*, /files/*  (UI is not served by this runtime)`);
  });
}

// `tsx runtime/node/index.ts` runs the server; importing the module does not.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
