import { Hono } from "hono";
import type { Deps } from "../../types";
import { authorizeService } from "../../auth/access";
import type { ProjectAction } from "../../auth/permissions";
import type { ServicePrincipal } from "../../auth/types";
import { parseBucketName, type CompatBucket, type ObjectKey } from "../model";
import { exchangeAssertion, gcsAuth, type GcsEnv } from "./auth";
import { gcsError, surfaceOf, type GcsErrorCode } from "./wire";

export type GcsDeps = Pick<Deps, "compat" | "projects" | "serviceAuthorizer" | "signingSecret">;

export function gcsApp(deps: GcsDeps, apiOrigin: string) {
  const app = new Hono<GcsEnv>();
  const tokenConfig = { apiOrigin, secret: deps.signingSecret };

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

/**
 * An unknown bucket is 404. A bucket the credential may not use, in its own
 * project or another, is 403, as GCS answers a caller without permission.
 */
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
  return decision.ok ? { ok: true, bucket } : { ok: false, code: "forbidden" };
}
