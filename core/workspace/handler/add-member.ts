import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { canManageRole } from "../../auth/roles";
import { addMember } from "../../member/usecase";
import {
  memberResponseSchema, idParamSchema, addMemberBodySchema,
} from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerAddMemberRoute(app: Hono<AppEnv>) {
  app.post("/:id/members",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Add member to workspace",
      responses: {
        201: jsonResponse("Member added", memberResponseSchema),
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        409: jsonError("Conflict"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", addMemberBodySchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = c.get("members");
      const authorizer = c.get("authorizer");
      const { id: workspaceId } = c.req.valid("param");

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
      if (!canManageRole(self.role, body.role)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      try {
        const member = await addMember(members, workspaceId, body.userId, body.role);
        return c.json({ member }, 201);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 409);
      }
    },
  );
}
