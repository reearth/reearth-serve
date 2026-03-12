import { Hono } from "hono";
import type { AppEnv } from "../types";
import { createProject, getProject, listProjects, deleteProject } from "./usecase";

export const projectRoutes = new Hono<AppEnv>();

// GET /api/v1/projects — list projects for current user
projectRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required. Run `login` to access project commands." }, 401);
  }

  const projects = c.get("projects");
  const workspaceId = c.req.query("workspaceId");
  const list = await listProjects(projects, workspaceId ? { workspaceId } : { ownerId: user.sub });
  return c.json({ projects: list });
});

// POST /api/v1/projects — create a project
projectRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const body = await c.req.json<{ name?: string; workspaceId?: string }>();
  if (!body.name) {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const projects = c.get("projects");
  const project = await createProject(projects, body.name, user.sub, body.workspaceId);
  return c.json({ project }, 201);
});

// GET /api/v1/projects/:id — get project
projectRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const projects = c.get("projects");
  const project = await getProject(projects, c.req.param("id"));
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({ project });
});

// DELETE /api/v1/projects/:id — delete project (owner only)
projectRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const projects = c.get("projects");
  const deleted = await deleteProject(projects, c.req.param("id"), user.sub);
  if (!deleted) {
    return c.json({ error: "Project not found or not authorized" }, 404);
  }

  return c.body(null, 204);
});
