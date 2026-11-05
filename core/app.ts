import { Hono, type Context, type MiddlewareHandler } from "hono";
import { generateSpecs, type GenerateSpecOptions } from "hono-openapi";
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
 * `adapters/cloudflare/cloudflare-deps.ts` (ADR-012 §1).
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Authentication middleware (JWKS cache comes from deps).
  //
  // `/api/internal/*` is excluded: it authenticates with the shared secret in
  // the same Authorization header (see `internalApiAuth` below, and the
  // extraction container's callback in container/archive-extractor). Running
  // the OIDC middleware there would try to verify that secret as a JWT and
  // reject every container callback with 401 as soon as an issuer is
  // configured — i.e. in production.
  app.use("*", exceptInternalApi(authMiddleware(deps.auth)));

  // Anonymous session tracking (for unauthenticated users). Internal callers
  // are machines with their own credential; minting a demo session per
  // container callback would only burn a KV write.
  app.use("*", exceptInternalApi(exceptFileDelivery(sessionMiddleware(deps.sessions, deps.sessionTtlSeconds))));

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
    c.set("writes", deps.writes);
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
  app.get("/api/v1/doc", async (c) => c.json(await openApiSpec(app)));

  app.get("/api/v1/docs", Scalar({ url: "/api/v1/doc" }));

  return app;
}

const OPENAPI_DOCUMENTATION: GenerateSpecOptions["documentation"] = {
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
    { name: "Files", description: "Public file delivery (permalink URLs)" },
  ],
  // Read by authMiddleware / sessionMiddleware on every non-internal
  // route. Both are optional: no credentials means demo mode, so `{}` is
  // listed too. Routes that ignore credentials override with `security: []`.
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "OIDC access token. Invalid or expired token → 401. Without it the caller is anonymous (demo mode).",
      },
      sessionId: {
        type: "apiKey",
        in: "header",
        name: "X-Session-Id",
        description: "Anonymous (demo-mode) session. Malformed ID → 401; unknown ID → a new session is minted and returned in the X-Session-Id response header. Ignored when bearerAuth is present.",
      },
    },
  },
  security: [{ bearerAuth: [] }, { sessionId: [] }, {}],
};

let cachedSpec: ReturnType<typeof generateSpecs> | undefined;

/**
 * Generate the OpenAPI document once per isolate.
 *
 * hono-openapi converts each route's `resolver()` schemas in place, and the
 * route specs live on module-level routers shared by every `createApp`. A
 * second generation therefore finds nothing left to resolve, drops
 * `components.schemas` and leaves dangling `$ref`s. `createApp` runs per
 * request on Workers, so the per-app cache of `openAPIRouteHandler` is not
 * enough. Routes are identical across apps, so one cached document serves all.
 */
function openApiSpec(app: Hono<AppEnv>): ReturnType<typeof generateSpecs> {
  cachedSpec ??= generateSpecs(app, { documentation: OPENAPI_DOCUMENTATION }).catch((e: unknown) => {
    cachedSpec = undefined;
    throw e;
  });
  return cachedSpec;
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

const INTERNAL_API_PREFIX = "/api/internal/";

/**
 * Run `mw` for every request except `/api/internal/*`. Internal callers
 * present a shared secret, not an end-user identity, so the OIDC and session
 * middlewares must not see them. The context vars those middlewares would
 * have set are filled with `null` so the rest of the app can still read them.
 */
function exceptInternalApi(mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.req.path.startsWith(INTERNAL_API_PREFIX)) return mw(c, next);
    if (c.get("user") === undefined) c.set("user", null);
    if (c.get("sessionId") === undefined) c.set("sessionId", null);
    await next();
  };
}

function exceptFileDelivery(mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (path !== "/files" && !path.startsWith("/files/")) return mw(c, next);
    c.set("sessionId", null);
    await next();
  };
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
