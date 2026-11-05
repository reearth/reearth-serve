import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { canManageRole } from "../../auth/permissions";
import { updateMemberRole } from "../../member/usecase";
import { requireTenancyAdmin } from "../../tenancy/middleware";
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
        405: { description: "Members are managed by an external directory", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", workspaceMemberParamSchema),
    zValidator("json", updateMemberBodySchema),
    async (c) => {
      const admin = requireTenancyAdmin(c);
      if (admin instanceof Response) return admin;

      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = admin.members;
      const { workspaceId, userId: targetUserId } = c.req.valid("param");

      const access = await authorizeWorkspace(accessCtx(c), workspaceId, "manage_members");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found", forbiddenAs: 403 });
      const self = access.value;

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
