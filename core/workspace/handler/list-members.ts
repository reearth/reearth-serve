import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { listMembers } from "../../member/usecase";
import { memberListResponseSchema, idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerListMembersRoute(app: Hono<AppEnv>) {
  app.get("/:id/members",
    describeRoute({
      tags: ["Workspaces"],
      summary: "List workspace members",
      responses: {
        200: jsonResponse("Member list", memberListResponseSchema),
        401: jsonError("Authentication required"),
        404: jsonError("Workspace not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const members = c.get("members");
      const { id: workspaceId } = c.req.valid("param");

      const self = await members.find(workspaceId, user.sub);
      if (!self) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const list = await listMembers(members, workspaceId);
      return c.json({ members: list });
    },
  );
}
