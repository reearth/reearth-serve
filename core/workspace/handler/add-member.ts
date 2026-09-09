import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { addMember } from "../../member/usecase";
import {
  memberResponseSchema, errorResponseSchema,
  workspaceIdParamSchema, addMemberBodySchema,
} from "../../../shared/openapi";

export function registerAddMemberRoute(app: Hono<AppEnv>) {
  app.post("/:workspaceId/members",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Add member to workspace",
      responses: {
        201: { description: "Member added", content: { "application/json": { schema: resolver(memberResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        403: { description: "Forbidden", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        409: { description: "Conflict", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", workspaceIdParamSchema),
    zValidator("json", addMemberBodySchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = c.get("members");
      const authorizer = c.get("authorizer");
      const { workspaceId } = c.req.valid("param");

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
        const member = await addMember(members, workspaceId, body.userId, body.role);
        return c.json({ member }, 201);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 409);
      }
    },
  );
}
