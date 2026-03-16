import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { createProject, getProject, listProjects, deleteProject } from "./usecase";
import {
  projectResponseSchema, projectListResponseSchema, errorResponseSchema,
  idParamSchema, projectListQuerySchema, createProjectBodySchema,
} from "../../shared/openapi";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.get("/",
  describeRoute({
    tags: ["Projects"],
    summary: "List projects",
    responses: {
      200: { description: "Project list", content: { "application/json": { schema: resolver(projectListResponseSchema) } } },
      401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
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
    const list = await listProjects(projects, workspaceId ? { workspaceId } : { ownerId: user.sub });
    return c.json({ projects: list });
  },
);

projectRoutes.post("/",
  describeRoute({
    tags: ["Projects"],
    summary: "Create a project",
    responses: {
      201: { description: "Project created", content: { "application/json": { schema: resolver(projectResponseSchema) } } },
      400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
    },
  }),
  zValidator("json", createProjectBodySchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = c.req.valid("json");
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
      200: { description: "Project details", content: { "application/json": { schema: resolver(projectResponseSchema) } } },
      401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      404: { description: "Project not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
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

    return c.json({ project });
  },
);

projectRoutes.delete("/:id",
  describeRoute({
    tags: ["Projects"],
    summary: "Delete project",
    responses: {
      204: { description: "Project deleted" },
      401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      404: { description: "Project not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
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
