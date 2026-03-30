import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, deleteAsset } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  app.delete("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Delete asset",
      responses: {
        204: { description: "Asset deleted" },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const storage = c.get("storage");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "delete")) {
        return c.json({ error: "Asset not found" }, 404);
      }

      // Delete all versions (and get total size for storage accounting)
      const { totalSize: versionsTotalSize } = await versions.deleteByAssetId(id);

      const deleted = await deleteAsset(metadata, storage, id);
      if (!deleted) {
        return c.json({ error: "Asset not found" }, 404);
      }

      // Update storage usage counters
      if (asset.projectId) {
        const storageUsage = c.get("storageUsage");
        const projects = c.get("projects");
        const totalSize = asset.size + versionsTotalSize;
        await storageUsage.decrement(`project:${asset.projectId}`, totalSize);
        const project = await projects.find(asset.projectId);
        if (project?.workspaceId) {
          await storageUsage.decrement(`workspace:${project.workspaceId}`, totalSize);
        }
      }

      return c.body(null, 204);
    },
  );
}
