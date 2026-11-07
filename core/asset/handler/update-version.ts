import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, updateVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { versionResponseSchema, versionParamSchema, updateVersionBodySchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerUpdateVersionRoute(app: Hono<AppEnv>) {
  app.patch("/:id/versions/:versionId",
    describeRoute({
      tags: ["Versions"],
      summary: "Update version metadata",
      description: "Update mutable version fields: userMeta.",
      responses: {
        200: jsonResponse("Updated version", versionResponseSchema),
        404: jsonError("Not found"),
      },
    }),
    zValidator("param", versionParamSchema),
    zValidator("json", updateVersionBodySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id, versionId } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "update_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const body = c.req.valid("json");
      const updated = await updateVersion(versions, id, versionId, body);
      if (!updated) {
        return c.json({ error: "Version not found" }, 404);
      }

      return c.json({ version: updated });
    },
  );
}
