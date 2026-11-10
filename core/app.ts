import { Hono, type Context, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { assetRoutes } from "./asset/handler";
import { fileRoutes } from "./file/handler";
import { jobRoutes, jobInternalRoutes } from "./job/handler";
import { projectRoutes } from "./project/handler";
import { workspaceRoutes } from "./workspace/handler";
import { meRoutes } from "./me/handler";
import { authMiddleware, verifyAccessToken } from "./auth/middleware";
import { sessionMiddleware } from "./session/middleware";
import { normalizeSiteHostSuffix, siteHostMiddleware } from "./site/middleware";
import { composeSiteHostResolver } from "./site/resolver";
import { bindsCaller, tenancyErrorResponse, tenancyMiddleware, TENANCY_RETRY_AFTER_SECONDS } from "./tenancy/middleware";
import type { AppEnv, Deps } from "./types";
import type { BearerVerifier } from "./access/restricted";
import { buildSpec, jsonError, jsonResponse } from "./openapi";
import { healthExamples } from "./openapi-examples";
import { healthResponseSchema } from "../shared/openapi";

/**
 * Builds the HTTP application from an already-assembled dependency set.
 *
 * `createApp` knows nothing about Cloudflare (or any other provider): the
 * env-to-adapter wiring lives in a composition root such as
 * `adapters/cloudflare/cloudflare-deps.ts` (ADR-012 §1).
 */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    const tenancyError = tenancyErrorResponse(err, c);
    if (tenancyError) return tenancyError;
    if ("getResponse" in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });

  // Site hosts (ADR-013 B1). First of all the middlewares and ahead of every
  // route: a request whose Host is `{id}{SITE_HOST_SUFFIX}` must resolve
  // through file delivery and nothing else, so it is dispatched into a
  // file-only app instead of continuing down this router. It also runs before
  // OIDC and session tracking — a hosted page is pure file delivery, and
  // minting an anonymous session per page view would burn a KV write for an
  // identity nothing reads.
  const site = siteApp(deps);
  // The resolver decides ID hosts, preview hosts and named hosts in that order
  // (ADR-013 B6). It needs the normalised suffix to rebuild the full hostname
  // a `site_hosts` row is keyed by; when site hosts are off the middleware
  // never calls it.
  const suffix = normalizeSiteHostSuffix(deps.siteHostSuffix);
  app.use("*", siteHostMiddleware({
    suffix: deps.siteHostSuffix,
    // The apex is the one host that is never a site (ADR-013 B5): a custom
    // domain is unrecognisable from its name, so the rule had to become "every
    // host but this one is a candidate".
    baseUrl: deps.baseUrl,
    serve: (req) => site.fetch(req),
    resolve: suffix
      ? composeSiteHostResolver({
        hosts: deps.siteHosts, versions: deps.versions, cache: deps.cache, suffix,
      })
      : undefined,
  }));

  // Authentication middleware (JWKS cache comes from deps).
  //
  // `/api/internal/*` is excluded: it authenticates with the shared secret in
  // the same Authorization header (see `internalApiAuth` below, and the
  // extraction container's callback in container/archive-extractor). Running
  // the OIDC middleware there would try to verify that secret as a JWT and
  // reject every container callback with 401 as soon as an issuer is
  // configured — i.e. in production.
  //
  // `/files/*` is excluded for a second reason (ADR-013 B7): since password
  // protection, `Authorization: Basic` is a meaningful credential there, and
  // the OIDC middleware rejects every Authorization header that is not a
  // Bearer token with 401 — so a `curl -u` against a protected asset would
  // never reach the file handler that knows what to do with it. The same
  // requests already bypass this middleware on a site host (B1: a hosted page
  // is pure file delivery), and the apex path form should not differ.
  app.use("*", exceptAuthless(authMiddleware(deps.auth)));

  app.use("*", tenancyMiddleware(deps.tenancy));

  // Anonymous session tracking (for unauthenticated users). Internal callers
  // are machines with their own credential; minting a demo session per
  // container callback would only burn a KV write.
  app.use("*", exceptInternalApi(exceptFileDelivery(sessionMiddleware(deps.sessions, deps.sessionTtlSeconds))));

  // Inject dependencies into all routes
  const bearerVerifier: BearerVerifier | null = deps.auth.issuer
    ? (jwt) => verifyAccessToken(jwt, deps.auth)
    : null;
  app.use("*", injectDeps(deps, { siteHost: false, bearerVerifier }));

  // Public API (versioned)
  app.get("/api/v1/health",
    describeRoute({
      tags: ["System"],
      summary: "Health check",
      description: "Liveness probe. `anonymousUploadEnabled` tells clients whether uploads without credentials (demo mode) are accepted.",
      responses: {
        200: jsonResponse("Service is up", healthResponseSchema, healthExamples),
        // From authMiddleware / sessionMiddleware, which run here like on every public route.
        401: jsonError("Malformed Authorization header, invalid or expired token, or malformed X-Session-Id"),
      },
    }),
    (c) => c.json({ ok: true, anonymousUploadEnabled: deps.anonymousUploadEnabled }),
  );
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

let cachedSpec: ReturnType<typeof buildSpec> | undefined;

/**
 * The OpenAPI document, built once per isolate. `createApp` runs per request
 * on Workers; routes are identical across apps, so one document serves them
 * all. The cache lives in this module on purpose: it imports every route, so
 * Vite's HMR reloads it (emptying the cache) whenever a route changes.
 */
function openApiSpec(app: Hono<AppEnv>): ReturnType<typeof buildSpec> {
  cachedSpec ??= buildSpec(app)
    .then(declareTenancyUnavailable)
    .catch((e: unknown) => {
      cachedSpec = undefined;
      throw e;
    });
  return cachedSpec;
}

const TENANCY_UNAVAILABLE_RESPONSE = {
  description: "Authorization service unavailable",
  headers: {
    "Retry-After": {
      description: "Seconds to wait before retrying",
      schema: { type: "integer", const: TENANCY_RETRY_AFTER_SECONDS },
    },
  },
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
} as const;

type Spec = Awaited<ReturnType<typeof buildSpec>>;

function declareTenancyUnavailable(spec: Spec): Spec {
  spec.components ??= {};
  spec.components.responses = { ...spec.components.responses, TenancyUnavailable: TENANCY_UNAVAILABLE_RESPONSE };
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!bindsCaller(path)) continue;
    for (const op of Object.values(item ?? {})) {
      if (op && typeof op === "object" && "responses" in op && op.responses) {
        op.responses["503"] ??= { $ref: "#/components/responses/TenancyUnavailable" };
      }
    }
  }
  return spec;
}

/**
 * The router a site host is served by (ADR-013 B1): file delivery and nothing
 * else. It is a separate Hono instance rather than a path guard on the main
 * app because "no API route can match here" is then a property of the router,
 * not of a rule someone has to remember when adding a route.
 */
function siteApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  // No auth and no session middleware: a hosted page is capability-URL file
  // delivery, and the handlers below read neither `user` nor `sessionId`. No
  // bearer verifier either: a restricted asset on a site host accepts only a
  // delivery token (ADR-014 §5).
  app.use("*", injectDeps(deps, { siteHost: true, bearerVerifier: null }));
  app.route("/files", fileRoutes);
  return app;
}

/** Request-independent collaborators, read off the context by every handler. */
function injectDeps(
  deps: Deps,
  opts: { siteHost: boolean; bearerVerifier: BearerVerifier | null },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("metadata", deps.metadata);
    c.set("versions", deps.versions);
    c.set("storage", deps.storage);
    c.set("uploadSessions", deps.uploadSessions);
    c.set("presignedUrls", deps.presignedUrls);
    c.set("jobs", deps.jobs);
    c.set("ttlSeconds", deps.ttlSeconds);
    c.set("baseUrl", deps.baseUrl);
    c.set("projects", deps.projects);
    c.set("extractionQueue", deps.extractionQueue);
    c.set("thumbnailQueue", deps.thumbnailQueue);
    c.set("writes", deps.writes);
    c.set("storageUsage", deps.storageUsage);
    c.set("pendingCleanup", deps.pendingCleanup);
    c.set("anonymousUploadEnabled", deps.anonymousUploadEnabled);
    c.set("siteHostSuffix", deps.siteHostSuffix);
    c.set("siteHosts", deps.siteHosts);
    c.set("dns", deps.dns);
    c.set("customHostnames", deps.customHostnames);
    c.set("siteFallbackOrigin", deps.siteFallbackOrigin);
    c.set("cache", deps.cache);
    c.set("signingSecret", deps.signingSecret);
    c.set("credentialedOrigins", deps.credentialedOrigins);
    c.set("siteHost", opts.siteHost);
    c.set("bearerVerifier", opts.bearerVerifier);
    await next();
  };
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
const FILES_PREFIX = "/files";

/**
 * Run `mw` for every request except `/api/internal/*`. Internal callers
 * present a shared secret, not an end-user identity, so the OIDC and session
 * middlewares must not see them. The context vars those middlewares would
 * have set are filled with `null` so the rest of the app can still read them.
 */
function exceptInternalApi(mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return exceptPrefixes([INTERNAL_API_PREFIX], mw);
}

/**
 * The same, plus `/files/*`: neither the internal API nor file delivery
 * carries an end-user identity this middleware could establish.
 */
function exceptAuthless(mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return exceptPrefixes([INTERNAL_API_PREFIX, FILES_PREFIX], mw);
}

function exceptPrefixes(prefixes: string[], mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  // A prefix must end at a segment boundary: `/files` exempts `/files` and
  // `/files/…` but never a future `/filestore`, which would otherwise inherit
  // an exemption nobody meant to give it.
  const matches = (path: string, prefix: string) =>
    path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  return async (c, next) => {
    if (!prefixes.some((prefix) => matches(c.req.path, prefix))) return mw(c, next);
    if (c.get("caller") === undefined) c.set("caller", null);
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
