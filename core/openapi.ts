import type { Hono } from "hono";
import { generateSpecs, resolver, type DescribeRouteOptions, type GenerateSpecOptions } from "hono-openapi";
import type { z } from "zod";
import type { AppEnv } from "./types";
import { contentEncodingHeaderSchema, openApiComponentSchemas, skipExtractionHeaderSchema } from "../shared/api";
import {
  errorResponseSchema, idParamSchema, scopedListQuerySchema, siteHostParamSchema, versionParamSchema,
  workspaceMemberParamSchema,
} from "../shared/openapi";

// OpenAPI building blocks for the route handlers' `describeRoute`, and the
// document builder. Handlers import from here, never the other way round.

type ParameterSpec = NonNullable<DescribeRouteOptions["parameters"]>[number];
type ResponseSpec = NonNullable<DescribeRouteOptions["responses"]>[string];

/** `$ref` to the `components.schemas` entry of a schema named with `component()`. */
export function schemaRef(schema: z.ZodType): { $ref: string } {
  const ref = (schema.meta() as { ref?: unknown } | undefined)?.ref;
  if (typeof ref !== "string") throw new Error("OpenAPI: schemaRef() needs a schema named with component()");
  return { $ref: `#/components/schemas/${ref}` };
}

/** JSON response with a (named) schema and optional media-type examples. */
export function jsonResponse(
  description: string,
  schema: Parameters<typeof resolver>[0],
  examples?: Record<string, { summary?: string; description?: string; value: unknown }>,
): ResponseSpec {
  return { description, content: { "application/json": { schema: resolver(schema), ...(examples ? { examples } : {}) } } };
}

/** JSON `Error` response. Identical ones are swapped for a `components.responses` entry. */
export function jsonError(description: string): ResponseSpec {
  return { description, content: { "application/json": { schema: resolver(errorResponseSchema) } } };
}

// --- Upload headers ---
//
// Read identically by the direct-upload routes (`POST /api/v1/assets`,
// `POST /api/v1/assets/{id}`). Published under `components.parameters` like
// the path and query parameters below.

/**
 * The header `resolveUploadProject` (core/asset/handler/shared.ts) reads.
 * Optional in the spec because anonymous uploads don't send it; routes using
 * it must also declare the 400 / 404 it produces.
 */
export const projectIdHeaderParam: ParameterSpec = {
  name: "X-Project-Id",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "Project to upload into. Required for authenticated callers (missing → 400, unknown or inaccessible project → 404 \"Project not found\"). Ignored for anonymous (demo-mode) callers.",
};

export const filenameHeaderParam: ParameterSpec = {
  name: "X-Filename",
  in: "header",
  required: true,
  schema: { type: "string" },
  description: "Filename of the uploaded file",
};

export const contentLengthHeaderParam: ParameterSpec = {
  name: "Content-Length",
  in: "header",
  required: true,
  schema: { type: "integer" },
  description: "File size in bytes",
};

export const contentEncodingHeaderParam: ParameterSpec = {
  name: "Content-Encoding",
  in: "header",
  required: false,
  schema: schemaRef(contentEncodingHeaderSchema),
  description: "Set to 'gzip' for pre-compressed uploads",
};

export const originalSizeHeaderParam: ParameterSpec = {
  name: "X-Original-Size",
  in: "header",
  required: false,
  schema: { type: "integer" },
  description: "Original uncompressed size (when Content-Encoding: gzip)",
};

export const skipExtractionHeaderParam: ParameterSpec = {
  name: "X-Skip-Extraction",
  in: "header",
  required: false,
  schema: schemaRef(skipExtractionHeaderSchema),
  description: "Skip archive extraction",
};

// --- Shared parameters and responses ---
//
// Generated clients get one type per shared parameter / response instead of a
// copy per operation. Neither needs per-route wiring: buildSpec() swaps every
// inline parameter or response identical to a shared one for its `$ref`, so
// routes keep writing `idParamSchema` validators and `jsonError("…")`.

/**
 * `components.responses`, by name → description. Each is a `jsonError` with
 * that description. A response used by more than one operation belongs here
 * (core/openapi.test.ts enforces it); reword one instead if it differs.
 */
const sharedErrorResponses = {
  BadRequest: "Bad request",
  Unauthorized: "Authentication required",
  UploadUnauthorized: "Anonymous upload disabled, or invalid token / session ID",
  Forbidden: "Forbidden",
  NotFound: "Not found",
  AssetNotFound: "Asset not found",
  AssetOrHostNotFound: "Asset or host not found",
  JobNotFound: "Job not found",
  MemberNotFound: "Member not found",
  ProjectNotFound: "Project not found",
  WorkspaceNotFound: "Workspace not found",
  ScopeNotAccessible: "Scope not accessible",
  StorageCapacityExceeded: "Upload exceeds storage capacity",
  MembersManagedExternally: "Members are managed by an external directory",
  WorkspacesManagedExternally: "Workspaces are managed by an external directory",
} satisfies Record<string, string>;

const OPENAPI_DOCUMENTATION: GenerateSpecOptions["documentation"] = {
  info: {
    title: "Serve API",
    version: "1.0.0",
    description: "Spatial Data Delivery API",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Assets", description: "Asset upload, metadata, and management" },
    { name: "Versions", description: "Asset versions: upload, list, update, and choose the active one" },
    { name: "Jobs", description: "Background job tracking" },
    { name: "Projects", description: "Project management" },
    { name: "Workspaces", description: "Workspace and member management" },
    { name: "Auth", description: "Authentication and user info" },
    { name: "Files", description: "Public file delivery (permalink URLs)" },
    { name: "System", description: "Service health" },
  ],
  components: {
    // `schemas`, `parameters`, and `responses` are added per generation in
    // buildSpec().
    // Read by authMiddleware / sessionMiddleware on every non-internal
    // route. Both are optional: no credentials means demo mode, so `{}` is
    // listed too. Routes that ignore credentials override with `security: []`.
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "OIDC access token. Invalid or expired token → 401. Without it the caller is anonymous (demo mode).",
      },
      sessionId: {
        type: "apiKey",
        in: "header",
        name: "X-Session-Id",
        description: "Anonymous (demo-mode) session. Malformed ID → 401; unknown ID → a new session is minted and returned in the X-Session-Id response header. Ignored when bearerAuth is present.",
      },
    },
  },
  security: [{ bearerAuth: [] }, { sessionId: [] }, {}],
};

/**
 * Generate the OpenAPI document. Not cached here: core/app.ts caches it.
 *
 * hono-openapi converts each route's `resolver()` schemas in place on the
 * module-level routers, and only collects `components.schemas` from schemas
 * it converts itself. Any route resolved before — by an earlier generation,
 * or in a module Vite's HMR did not reload — keeps its `$ref`s but adds no
 * components, so the document loses e.g. `Project` while still pointing at
 * it. The named schemas are therefore converted here from
 * `openApiComponentSchemas`, independently of route state.
 */
export async function buildSpec(app: Hono<AppEnv>): ReturnType<typeof generateSpecs> {
  const schemas: Record<string, unknown> = {};
  for (const schema of openApiComponentSchemas) {
    const { components } = await resolver(schema).toOpenAPISchema();
    Object.assign(schemas, components?.schemas);
  }
  const parameters = await sharedParameters();
  const responses = sharedResponses();

  // Fresh objects each time: generateSpecs merges route components into
  // `documentation.components` in place.
  const components = OPENAPI_DOCUMENTATION?.components ?? {};
  const documentation = {
    ...OPENAPI_DOCUMENTATION,
    components: {
      ...components,
      schemas: { ...components.schemas, ...schemas },
      parameters: { ...components.parameters, ...parameters },
      responses: { ...components.responses, ...responses },
    },
  } as GenerateSpecOptions["documentation"];

  const spec = await generateSpecs(app, { documentation });
  refShared(spec, "parameters", parameters);
  refShared(spec, "responses", responses);
  return spec;
}

type Parameter = { $ref?: string; in?: string; name?: string; [key: string]: unknown };

/**
 * `components.parameters`, keyed by component name. The path and query ones
 * are derived from the zod schemas the routes validate with, so they match
 * what hono-openapi generates for each route and cannot drift from it.
 * Query filters are named `…Filter` and headers `…Header`, so no component
 * collides with a path parameter or schema of the same name.
 */
async function sharedParameters(): Promise<Record<string, Parameter>> {
  return {
    ...await parametersFrom("path", idParamSchema, { id: "Id" }),
    ...await parametersFrom("path", versionParamSchema, { versionId: "VersionId" }),
    ...await parametersFrom("path", workspaceMemberParamSchema, { userId: "UserId" }),
    ...await parametersFrom("path", siteHostParamSchema, { hostname: "Hostname" }),
    ...await parametersFrom("query", scopedListQuerySchema, {
      limit: "Limit", cursor: "Cursor", workspaceId: "WorkspaceFilter", projectId: "ProjectFilter",
    }),
    // Named `…Header` so they don't collide with the `ContentEncoding` /
    // `XSkipExtraction` schemas: oapi-codegen emits a Go type for each.
    ProjectIdHeader: projectIdHeaderParam,
    FilenameHeader: filenameHeaderParam,
    ContentLengthHeader: contentLengthHeaderParam,
    ContentEncodingHeader: contentEncodingHeaderParam,
    OriginalSizeHeader: originalSizeHeaderParam,
    SkipExtractionHeader: skipExtractionHeaderParam,
  } as Record<string, Parameter>;
}

/** `components.responses`, in the shape hono-openapi emits `jsonError()` in. */
function sharedResponses(): Record<string, unknown> {
  const content = { "application/json": { schema: schemaRef(errorResponseSchema) } };
  return Object.fromEntries(
    Object.entries(sharedErrorResponses).map(([name, description]) => [name, { description, content }]),
  );
}

/** Mirrors hono-openapi's own parameter generation for a validator target. */
async function parametersFrom(
  location: "path" | "query",
  schema: Parameters<typeof resolver>[0],
  names: Record<string, string>,
): Promise<Record<string, Parameter>> {
  const { schema: json } = await resolver(schema).toOpenAPISchema() as {
    schema: { properties?: Record<string, { description?: string }>; required?: string[] };
  };
  const out: Record<string, Parameter> = {};
  for (const [name, component] of Object.entries(names)) {
    const prop = json.properties?.[name];
    if (!prop) throw new Error(`OpenAPI: ${location} schema has no "${name}" for ${component}`);
    const { description, ...propSchema } = prop;
    out[component] = {
      in: location,
      name,
      schema: propSchema,
      ...(json.required?.includes(name) ? { required: true } : {}),
      ...(description ? { description } : {}),
    };
  }
  return out;
}

/** Key-order-independent JSON, for comparing parameter objects. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type Spec = Awaited<ReturnType<typeof generateSpecs>>;

/**
 * Replace every inline parameter / response identical to a shared one with its
 * `$ref`. One that differs (e.g. its own description) stays inline.
 */
function refShared(spec: Spec, kind: "parameters" | "responses", shared: Record<string, unknown>): void {
  const byShape = new Map(Object.entries(shared).map(([name, value]) => [canonical(value), name]));
  const ref = (value: unknown) => {
    const name = (value as { $ref?: string }).$ref ? undefined : byShape.get(canonical(value));
    return name ? { $ref: `#/components/${kind}/${name}` } : value;
  };
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(ops ?? {}) as { parameters?: unknown[]; responses?: Record<string, unknown> }[]) {
      if (kind === "parameters" && op?.parameters) op.parameters = op.parameters.map(ref);
      if (kind === "responses" && op?.responses) {
        op.responses = Object.fromEntries(Object.entries(op.responses).map(([status, r]) => [status, ref(r)]));
      }
    }
  }
}
