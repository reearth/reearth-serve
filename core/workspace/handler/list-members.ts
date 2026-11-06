import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { listMembers } from "../../member/usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
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

      const { id: workspaceId } = c.req.valid("param");
      const access = await authorizeWorkspace(accessCtx(c), workspaceId, "read");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found" });

      const list = await listMembers(c.get("members"), workspaceId);
      return c.json({ members: list });
    },
  );
}
