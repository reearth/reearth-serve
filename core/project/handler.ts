import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { createProject, getProject, listProjects, deleteProject } from "./usecase";
import {
  projectResponseSchema, projectListResponseSchema, idParamSchema, projectListQuerySchema, createProjectBodySchema,
} from "../../shared/openapi";
import { registerProjectHostRoutes } from "../site/handler";
import { jsonError, jsonResponse } from "../openapi";

export const projectRoutes = new Hono<AppEnv>();

// Site hosts across the project (ADR-013 B6). Registered from core/site so the
// whole hosts API reads in one file.
registerProjectHostRoutes(projectRoutes);

projectRoutes.get("/",
  describeRoute({
    tags: ["Projects"],
    summary: "List projects",
    responses: {
      200: jsonResponse("Project list", projectListResponseSchema),
      401: jsonError("Authentication required"),
      404: jsonError("Workspace not found"),
    },
  }),
  zValidator("query", projectListQuerySchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required. Run `login` to access project commands." }, 401);
    }

    const projects = c.get("projects");
    const { workspaceId } = c.req.valid("query");
    if (workspaceId) {
      // Require membership before listing the workspace's projects, otherwise
      // any authed caller could enumerate every workspace's projects just by
      // guessing IDs.
      const members = c.get("members");
      const member = await members.find(workspaceId, user.sub);
      if (!member) return c.json({ error: "Workspace not found" }, 404);
      const list = await listProjects(projects, { workspaceId });
      return c.json({ projects: list });
    }
    const list = await listProjects(projects, { ownerId: user.sub });
    return c.json({ projects: list });
  },
);

projectRoutes.post("/",
  describeRoute({
    tags: ["Projects"],
    summary: "Create a project",
    responses: {
      201: jsonResponse("Project created", projectResponseSchema),
      400: jsonError("Bad request"),
      401: jsonError("Authentication required"),
      403: jsonError("Forbidden"),
      404: jsonError("Workspace not found"),
    },
  }),
  zValidator("json", createProjectBodySchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = c.req.valid("json");
    if (body.workspaceId) {
      // 404 for non-members so the response doesn't confirm the workspace exists.
      const self = await c.get("members").find(body.workspaceId, user.sub);
      if (!self) {
        return c.json({ error: "Workspace not found" }, 404);
      }
      const allowed = await c.get("authorizer").check({
        principal: { id: user.sub, roles: [self.role] },
        resource: { kind: "project", id: body.workspaceId },
        action: "create",
      });
      if (!allowed) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }

    const projects = c.get("projects");
    const project = await createProject(projects, body.name, user.sub, body.workspaceId);
    return c.json({ project }, 201);
  },
);

projectRoutes.get("/:id",
  describeRoute({
    tags: ["Projects"],
    summary: "Get project",
    responses: {
      200: jsonResponse("Project details", projectResponseSchema),
      401: jsonError("Authentication required"),
      404: jsonError("Project not found"),
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const projects = c.get("projects");
    const project = await getProject(projects, c.req.valid("param").id);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Enforce visibility: owner, or a member of the project's workspace.
    // Return 404 (not 403) so we don't confirm existence to non-members.
    const isOwner = project.ownerId === user.sub;
    let isMember = false;
    if (project.workspaceId) {
      const members = c.get("members");
      isMember = (await members.find(project.workspaceId, user.sub)) !== null;
    }
    if (!isOwner && !isMember) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json({ project });
  },
);

projectRoutes.delete("/:id",
  describeRoute({
    tags: ["Projects"],
    summary: "Delete project",
    responses: {
      204: { description: "Project deleted" },
      401: jsonError("Authentication required"),
      404: jsonError("Project not found"),
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const projects = c.get("projects");
    const deleted = await deleteProject(projects, c.req.valid("param").id, user.sub);
    if (!deleted) {
      return c.json({ error: "Project not found or not authorized" }, 404);
    }

    return c.body(null, 204);
  },
);
