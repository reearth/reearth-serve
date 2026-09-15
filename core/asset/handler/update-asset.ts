import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, updateAsset, setAssetAccess, checkSpaChange, enrichAssetWithVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { assetResponseSchema, errorResponseSchema, idParamSchema, updateAssetBodySchema } from "../../../shared/openapi";

export function registerUpdateAssetRoute(app: Hono<AppEnv>) {
  app.patch("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Update asset metadata",
      description:
        "Update mutable asset fields: description, userMeta, activeVersionId, expiresAt, " +
        "the access mode (ADR-013 B7) and the SPA fallback (ADR-013 C1). " +
        "`{\"access\":\"password\",\"password\":\"…\"}` protects " +
        "a site (archive) asset in a project; `{\"access\":\"public\"}` unprotects it. Setting or " +
        "changing the password invalidates every outstanding auth cookie. `{\"spa\":true}` makes " +
        "an extensionless miss inside the archive serve its root `index.html` with status 200.",
      responses: {
        200: { description: "Updated asset", content: { "application/json": { schema: resolver(assetResponseSchema) } } },
        400: { description: "Protection or the SPA fallback is not available for this asset", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        503: { description: "SIGNING_SECRET not configured", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", updateAssetBodySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const existing = await getAssetMetadata(metadata, id);
      if (!existing || !await canAccessAsset(existing, accessCtx(c), "update")) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const body = c.req.valid("json");

      // The two fields that can fail for a reason other than "no such asset"
      // come first, and the cheap check comes before the write: applying the
      // harmless fields before refusing would leave a half-done PATCH behind.
      if (body.spa !== undefined) {
        const check = checkSpaChange(existing, body.spa);
        if (!check.ok) return c.json({ error: check.error }, check.status);
      }

      const access = body.access;
      if (access !== undefined) {
        const result = await setAssetAccess(metadata, existing, { access, password: body.password }, {
          signingSecret: c.get("signingSecret"),
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
      }

      const updated = await updateAsset(metadata, versions, id, body);
      if (!updated) {
        return c.json({ error: "Asset not found or invalid activeVersionId" }, 404);
      }

      const enriched = await enrichAssetWithVersion(metadata, versions, id);
      return c.json({ asset: enriched ?? updated });
    },
  );
}
