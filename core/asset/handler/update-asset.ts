import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, updateAsset, setAssetAccess, checkSpaChange, enrichAssetWithVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { assetResponseSchema, idParamSchema, updateAssetBodySchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

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
        200: jsonResponse("Updated asset", assetResponseSchema),
        400: jsonError("Protection or the SPA fallback is not available for this asset"),
        404: jsonError("Asset not found"),
        503: jsonError("SIGNING_SECRET not configured"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", updateAssetBodySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "update_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const existing = access.value;

      const body = c.req.valid("json");

      // The two fields that can fail for a reason other than "no such asset"
      // come first, and the cheap check comes before the write: applying the
      // harmless fields before refusing would leave a half-done PATCH behind.
      if (body.spa !== undefined) {
        const check = checkSpaChange(existing, body.spa);
        if (!check.ok) return c.json({ error: check.error }, check.status);
      }

      if (body.access !== undefined) {
        const result = await setAssetAccess(metadata, existing, { access: body.access, password: body.password }, {
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
