import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { registerCreateRoute } from "./create";
import { registerGetRoute } from "./get";
import { registerDeleteRoute } from "./delete";
import { registerListMembersRoute } from "./list-members";
import { registerAddMemberRoute } from "./add-member";
import { registerUpdateMemberRoleRoute } from "./update-member-role";
import { registerRemoveMemberRoute } from "./remove-member";

export const workspaceRoutes = new Hono<AppEnv>();

// Workspace CRUD
registerCreateRoute(workspaceRoutes);
registerGetRoute(workspaceRoutes);
registerDeleteRoute(workspaceRoutes);

// Member management (nested under /:workspaceId/members)
registerListMembersRoute(workspaceRoutes);
registerAddMemberRoute(workspaceRoutes);
registerUpdateMemberRoleRoute(workspaceRoutes);
registerRemoveMemberRoute(workspaceRoutes);
