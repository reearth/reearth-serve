import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { canManageRole } from "../../auth/roles";
import { updateMemberRole } from "../../member/usecase";
import {
  memberResponseSchema, workspaceMemberParamSchema, updateMemberBodySchema,
} from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerUpdateMemberRoleRoute(app: Hono<AppEnv>) {
  app.patch("/:id/members/:userId",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Update member role",
      responses: {
        200: jsonResponse("Member updated", memberResponseSchema),
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Member not found"),
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
      const { id: workspaceId, userId: targetUserId } = c.req.valid("param");

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
      const target = await members.find(workspaceId, targetUserId);
      if (!target) {
        return c.json({ error: "Member not found" }, 404);
      }
      if (!canManageRole(self.role, target.role) || !canManageRole(self.role, body.role)) {
        return c.json({ error: "Forbidden" }, 403);
      }

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
