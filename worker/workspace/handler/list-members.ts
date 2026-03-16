import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { listMembers } from "../../member/usecase";
import { memberListResponseSchema, errorResponseSchema, workspaceIdParamSchema } from "../../../shared/openapi";

export function registerListMembersRoute(app: Hono<AppEnv>) {
  app.get("/:workspaceId/members",
    describeRoute({
      tags: ["Workspaces"],
      summary: "List workspace members",
      responses: {
        200: { description: "Member list", content: { "application/json": { schema: resolver(memberListResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Workspace not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", workspaceIdParamSchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = c.get("members");
      const { workspaceId } = c.req.valid("param");

      const self = await members.find(workspaceId, user.sub);
      if (!self) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const list = await listMembers(members, workspaceId);
      return c.json({ members: list });
    },
  );
}
