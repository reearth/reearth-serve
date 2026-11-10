import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { usageScopes } from "./shared";
import { getAssetMetadata, deleteVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { versionParamSchema } from "../../../shared/openapi";
import { jsonError } from "../../openapi";

export function registerDeleteVersionRoute(app: Hono<AppEnv>) {
  app.delete("/:id/versions/:versionId",
    describeRoute({
      tags: ["Versions"],
      summary: "Delete a specific version",
      responses: {
        204: { description: "Version deleted" },
        404: jsonError("Not found"),
      },
    }),
    zValidator("param", versionParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id, versionId } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "delete_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const storage = c.get("storage");
      const pendingCleanup = c.get("pendingCleanup");
      // The usage counters move in the same write as the row (ADR-004,
      // ADR-012 §3), by the version's own size whether or not its bytes are a
      // blob other rows share (ADR-017 §4).
      const scopes = await usageScopes(c, asset.projectId);
      const deleted = await deleteVersion(versions, metadata, c.get("writes"), id, versionId, { storage, pendingCleanup, usageScopes: scopes });
      if (!deleted) {
        return c.json({ error: "Version not found" }, 404);
      }

      return c.body(null, 204);
    },
  );
}
