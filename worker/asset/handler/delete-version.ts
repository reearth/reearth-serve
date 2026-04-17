import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, deleteVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { errorResponseSchema, versionParamSchema } from "../../../shared/openapi";

export function registerDeleteVersionRoute(app: Hono<AppEnv>) {
  app.delete("/:id/versions/:versionId",
    describeRoute({
      tags: ["Versions"],
      summary: "Delete a specific version",
      responses: {
        204: { description: "Version deleted" },
        404: { description: "Not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", versionParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id, versionId } = c.req.valid("param");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "delete")) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const storage = c.get("storage");
      const pendingCleanup = c.get("pendingCleanup");
      const deleted = await deleteVersion(versions, metadata, id, versionId, { storage, pendingCleanup });
      if (!deleted) {
        return c.json({ error: "Version not found" }, 404);
      }

      // Update storage usage
      if (asset.projectId) {
        const storageUsage = c.get("storageUsage");
        const projects = c.get("projects");
        await storageUsage.decrement(`project:${asset.projectId}`, deleted.size);
        const project = await projects.find(asset.projectId);
        if (project?.workspaceId) {
          await storageUsage.decrement(`workspace:${project.workspaceId}`, deleted.size);
        }
      }

      return c.body(null, 204);
    },
  );
}
