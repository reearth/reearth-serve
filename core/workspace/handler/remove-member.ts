import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { canManageRole } from "../../auth/permissions";
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
      const { id: workspaceId, userId: targetUserId } = c.req.valid("param");

      const access = await authorizeWorkspace(accessCtx(c), workspaceId, "manage_members");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found", forbiddenAs: 403 });
      const self = access.value;

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
