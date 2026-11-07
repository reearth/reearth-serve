import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, deleteAsset } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { idParamSchema } from "../../../shared/openapi";
import { jsonError } from "../../openapi";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  app.delete("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Delete asset",
      responses: {
        204: { description: "Asset deleted" },
        404: jsonError("Asset not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const { id } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "delete_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const scopes: string[] = [];
      if (asset.projectId) {
        scopes.push(`project:${asset.projectId}`);
        const project = await c.get("projects").find(asset.projectId);
        if (project?.workspaceId) scopes.push(`workspace:${project.workspaceId}`);
      }

      await deleteAsset(c.get("writes"), c.get("storage"), asset, {
        usageScopes: scopes,
        pendingCleanup: c.get("pendingCleanup"),
      });

      return c.body(null, 204);
    },
  );
}
