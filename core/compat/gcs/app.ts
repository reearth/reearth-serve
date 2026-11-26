import { Hono } from "hono";
import type { Deps } from "../../types";
import { authorizeService, type Denial } from "../../auth/access";
import type { ProjectAction } from "../../auth/permissions";
import type { ServicePrincipal } from "../../auth/types";
import { parseBucketName, type CompatBucket, type ObjectKey } from "../model";
import { exchangeAssertion, gcsAuth, type GcsEnv, type TokenError } from "./auth";
import { gcsError, surfaceOf, type GcsErrorCode } from "./wire";

export type GcsDeps = Pick<Deps, "compat" | "projects" | "serviceAuthorizer" | "signingSecret">;

export function gcsApp(deps: GcsDeps, apiOrigin: string) {
  const app = new Hono<GcsEnv>();
  const tokenConfig = { apiOrigin, secret: deps.signingSecret };

  app.onError((err, c) => {
    console.error(err);
    if (c.req.path === "/token") {
      const body: TokenError = { error: "server_error", error_description: "The token endpoint failed." };
      return c.json(body, 500, { "Cache-Control": "no-store" });
    }
    return gcsError(surfaceOf(c.req.path), "backend_error");
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const field = (name: string) => (typeof form[name] === "string" ? form[name] : undefined);
    const result = await exchangeAssertion(
      deps.compat,
      { grantType: field("grant_type"), assertion: field("assertion") },
      { ...tokenConfig, now: Date.now() },
    );
    c.header("Cache-Control", "no-store");
    return result.ok ? c.json(result.value) : c.json(result.value, result.status);
  });

  app.use("*", gcsAuth(deps.compat, tokenConfig));

  app.get("/storage/v1/b/:bucket/o/:object", async (c) => {
    const found = await authorizedBucket(deps, c.get("service"), c.req.param("bucket"), "read_asset");
    if (!found.ok) return gcsError("json", found.code);
    const binding = await deps.compat.findBinding(found.bucket.name, c.req.param("object") as ObjectKey);
    if (!binding) return gcsError("json", "object_not_found", `No such object: ${found.bucket.name}/${c.req.param("object")}`);
    return gcsError("json", "not_implemented");
  });

  app.all("*", (c) => gcsError(surfaceOf(c.req.path), "not_implemented"));
  return app;
}

const DENIAL_CODE: Record<Denial["reason"], GcsErrorCode> = {
  not_found: "bucket_not_found",
  forbidden: "forbidden",
};

async function authorizedBucket(
  deps: GcsDeps,
  service: ServicePrincipal,
  raw: string,
  action: ProjectAction,
): Promise<{ ok: true; bucket: CompatBucket } | { ok: false; code: GcsErrorCode }> {
  const name = parseBucketName(raw);
  const bucket = name ? await deps.compat.findBucket(name) : null;
  if (!bucket) return { ok: false, code: "bucket_not_found" };
  const decision = await authorizeService(
    { authorizer: deps.serviceAuthorizer, projects: deps.projects },
    service,
    { projectId: bucket.projectId, bucket: bucket.name },
    action,
  );
  return decision.ok ? { ok: true, bucket } : { ok: false, code: DENIAL_CODE[decision.reason] };
}
