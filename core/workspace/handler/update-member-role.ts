import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { updateMemberRole } from "../../member/usecase";
import {
  memberResponseSchema, errorResponseSchema,
  workspaceMemberParamSchema, updateMemberBodySchema,
} from "../../../shared/openapi";

export function registerUpdateMemberRoleRoute(app: Hono<AppEnv>) {
  app.patch("/:workspaceId/members/:userId",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Update member role",
      responses: {
        200: { description: "Member updated", content: { "application/json": { schema: resolver(memberResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        403: { description: "Forbidden", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Member not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", workspaceMemberParamSchema),
    zValidator("json", updateMemberBodySchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = c.get("members");
      const authorizer = c.get("authorizer");
      const { workspaceId, userId: targetUserId } = c.req.valid("param");

      const self = await members.find(workspaceId, user.sub);
      if (!self) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const allowed = await authorizer.check({
        principal: { id: user.sub, roles: [self.role] },
        resource: { kind: "workspace", id: workspaceId },
        action: "manage-members",
      });
      if (!allowed) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const body = c.req.valid("json");

      try {
        const member = await updateMemberRole(members, workspaceId, targetUserId, body.role);
        if (!member) {
          return c.json({ error: "Member not found" }, 404);
        }
        return c.json({ member });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    },
  );
}
