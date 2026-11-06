import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { canManageRole } from "../../auth/roles";
import { removeMember } from "../../member/usecase";
import { workspaceMemberParamSchema } from "../../../shared/openapi";
import { jsonError } from "../../openapi";

export function registerRemoveMemberRoute(app: Hono<AppEnv>) {
  app.delete("/:id/members/:userId",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Remove member from workspace",
      responses: {
        204: { description: "Member removed" },
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Member not found"),
      },
    }),
    zValidator("param", workspaceMemberParamSchema),
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

      const target = await members.find(workspaceId, targetUserId);
      if (!target) {
        return c.json({ error: "Member not found" }, 404);
      }
      if (!canManageRole(self.role, target.role)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      try {
        const removed = await removeMember(members, workspaceId, targetUserId);
        if (!removed) {
          return c.json({ error: "Member not found" }, 404);
        }
        return c.body(null, 204);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    },
  );
}
