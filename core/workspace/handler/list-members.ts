import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { listMembers } from "../../member/usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
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

      const { workspaceId } = c.req.valid("param");
      const access = await authorizeWorkspace(accessCtx(c), workspaceId, "read");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found" });

      const list = await listMembers(c.get("tenancy").members, workspaceId);
      return c.json({ members: list });
    },
  );
}
