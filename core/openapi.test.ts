import { describe, expect, test } from "vitest";
import { createConfig, lintFromString } from "@redocly/openapi-core";
import { z } from "zod";
import { createApp } from "./app";
import { schemaRef } from "./openapi";
import { docOnlyDeps } from "./openapi.testing";
import { assetMetadataSchema } from "../shared/api";

test("schemaRef points at a named component and rejects an unnamed schema", () => {
  expect(schemaRef(assetMetadataSchema)).toEqual({ $ref: "#/components/schemas/Asset" });
  expect(() => schemaRef(z.string())).toThrow(/component\(\)/);
});

// External clients generate code from /api/v1/doc (oapi-codegen, for
// example), so anything a handler reads or returns must be declared here.
describe("OpenAPI document", () => {
  type Parameter = { $ref?: string; name: string; in: string; required?: boolean; schema?: unknown };
  type Operation = {
    parameters?: Parameter[];
    responses: Record<string, unknown>;
    security?: unknown[];
  };
  type Spec = {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown>; parameters?: Record<string, Parameter> };
  };

  /** An operation's parameters with `#/components/parameters/*` refs followed. */
  function paramsOf(spec: Spec, op: Operation): Parameter[] {
    return (op.parameters ?? []).map((p) =>
      p.$ref ? spec.components.parameters?.[p.$ref.split("/").pop()!] ?? p : p,
    );
  }

  async function loadSpec(): Promise<Spec> {
    const res = await createApp(docOnlyDeps()).request("/api/v1/doc");
    expect(res.status).toBe(200);
    return res.json();
  }

  test("passes Redocly's recommended OpenAPI 3.1 lint", async () => {
    // Covers what codegen trips over: unresolved $refs, undefined security
    // schemes, path templates without a matching path parameter, and schema
    // shapes that are not valid OpenAPI. Warnings (e.g. no info.license) are
    // allowed; errors fail the build.
    const problems = await lintFromString({
      source: JSON.stringify(await loadSpec()),
      absoluteRef: "openapi.json",
      // Examples are checked strictly: an example with a field the schema
      // doesn't declare is as misleading as a wrong type.
      config: await createConfig({
        extends: ["recommended"],
        rules: { "no-invalid-media-type-examples": { severity: "error", allowAdditionalProperties: false } },
      }),
    });
    // The NDJSON listing's schema describes one line (FileEntry) while its
    // examples are whole bodies (several lines of text), which no OpenAPI 3.1
    // schema can express; only that media type is exempt.
    const ndjsonExample = (p: (typeof problems)[number]) =>
      p.ruleId === "no-invalid-media-type-examples" && !!p.location[0]?.pointer?.includes("/content/application~1x-ndjson/");
    const errors = problems
      .filter((p) => p.severity === "error" && !ndjsonExample(p))
      .map((p) => `${p.ruleId} at ${p.location[0]?.pointer}: ${p.message}`);
    expect(errors).toEqual([]);
  });

  test("keeps named components when the app is rebuilt (one createApp per request)", async () => {
    // Regression: hono-openapi resolves schemas in place on module-level
    // routes, so regenerating for a fresh app dropped components.schemas
    // while the $refs stayed.
    const first = await loadSpec();
    const second = await loadSpec();
    expect(Object.keys(second.components.schemas)).toEqual(Object.keys(first.components.schemas));
    expect(second.components.schemas).toHaveProperty("Asset");
  });

  test("names the shared schemas as components", async () => {
    const { components } = await loadSpec();
    for (const name of ["Asset", "AssetVersion", "FileEntry", "Error", "Job", "Project", "Workspace", "Member"]) {
      expect(components.schemas, name).toHaveProperty(name);
    }
  });

  test("no parameter is inlined in more than one operation", async () => {
    // Each copy becomes its own Go field type in oapi-codegen; repeated
    // parameters belong in components.parameters (core/openapi.ts), and a
    // copy that differs from the shared one, e.g. in its description, is
    // left inline and shows up here.
    const { paths, components } = await loadSpec();
    const sharedKeys = new Set(Object.values(components.parameters ?? {}).map((p) => `${p.in} ${p.name}`));
    // Deliberately different from the shared parameter of the same name.
    const ownDefinition = new Set(["GET /files/{id}/{path} path id"]); // asset *or version* ID
    const seen = new Map<string, string[]>();
    const drifted: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const p of op.parameters ?? []) {
          if (p.$ref) continue;
          const key = `${p.in} ${p.name}`;
          const at = `${method.toUpperCase()} ${path}`;
          seen.set(key, [...(seen.get(key) ?? []), at]);
          if (sharedKeys.has(key) && !ownDefinition.has(`${at} ${key}`)) drifted.push(`${at} ${key}`);
        }
      }
    }
    expect([...seen].filter(([, ops]) => ops.length > 1)).toEqual([]);
    // Same header/query/path as a shared parameter but not identical to it.
    expect(drifted).toEqual([]);
  });

  test("list routes reference the shared pagination parameters", async () => {
    const { paths } = await loadSpec();
    for (const path of ["/api/v1/assets", "/api/v1/jobs", "/api/v1/assets/{id}/versions"]) {
      const params = paths[path].get.parameters;
      expect(params, path).toContainEqual({ $ref: "#/components/parameters/Limit" });
      expect(params, path).toContainEqual({ $ref: "#/components/parameters/Cursor" });
    }
  });

  test("no response is inlined in more than one operation", async () => {
    // Like parameters: each copy becomes its own Go type. A repeated one
    // belongs in sharedErrorResponses (core/openapi.ts), which swaps it for a
    // $ref; reword it if it really is a different response.
    const spec = await loadSpec() as Spec & { components: { responses?: Record<string, unknown> } };
    expect(spec.components.responses).toHaveProperty("Unauthorized");
    const seen = new Map<string, string[]>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const [status, res] of Object.entries(op.responses ?? {})) {
          if ((res as { $ref?: string }).$ref) continue;
          const key = `${status} ${JSON.stringify(res)}`;
          seen.set(key, [...(seen.get(key) ?? []), `${method.toUpperCase()} ${path}`]);
        }
      }
    }
    expect([...seen].filter(([, ops]) => ops.length > 1)).toEqual([]);
  });

  test("routes' error responses $ref the shared ones", async () => {
    const { paths } = await loadSpec();
    expect(paths["/api/v1/me"].get.responses["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
    expect(paths["/api/v1/assets/{id}"].get.responses["404"]).toEqual({ $ref: "#/components/responses/AssetNotFound" });
  });

  test("no enum is inlined more than once", async () => {
    // Each inline copy becomes its own Go type in oapi-codegen (MemberRole,
    // MeResponseWorkspacesRole, ...). Shared enums belong in components.
    const counts = new Map<string, string[]>();
    const walk = (node: unknown, at: string): void => {
      if (!node || typeof node !== "object") return;
      const { enum: values } = node as { enum?: unknown };
      if (Array.isArray(values)) {
        const key = JSON.stringify(values);
        counts.set(key, [...(counts.get(key) ?? []), at]);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${at}/${k}`);
    };
    walk(await loadSpec(), "#");
    const repeated = [...counts].filter(([, at]) => at.length > 1);
    expect(repeated).toEqual([]);
  });

  test("request and response bodies are named, not inlined per route", async () => {
    // An inline object body becomes an anonymous Go struct per operation in
    // oapi-codegen (e.g. `JSON200 *struct{ Asset Asset }` on every asset
    // route, or `PostApiV1ProjectsJSONBody`). Every JSON body should $ref a
    // component instead.
    type Content = { content?: Record<string, { schema?: { $ref?: string } }> };
    const { paths } = await loadSpec();
    const inline: string[] = [];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops as Record<string, { requestBody?: Content; responses?: Record<string, Content> }>)) {
        const bodies: [string, Content | undefined][] = [["request", op.requestBody], ...Object.entries(op.responses ?? {})];
        for (const [label, body] of bodies) {
          const schema = body?.content?.["application/json"]?.schema;
          if (schema && !schema.$ref) inline.push(`${method.toUpperCase()} ${path} ${label}`);
        }
      }
    }
    expect(inline).toEqual([]);
  });

  test.each([
    ["/api/v1/assets", "post"],
    ["/api/v1/assets/uploads", "post"],
  ])("%s %s declares X-Project-Id and the errors it produces", async (path, method) => {
    const spec = await loadSpec();
    const op = spec.paths[path][method];
    expect(paramsOf(spec, op)).toContainEqual(
      expect.objectContaining({ name: "X-Project-Id", in: "header", required: false }),
    );
    expect(op.responses).toHaveProperty("400");
    expect(op.responses).toHaveProperty("404");
  });

  test("upload routes share one schema per header enum", async () => {
    // oapi-codegen generates one Go type per inline enum per route; a $ref'd
    // schema gives both routes the same ContentEncoding / XSkipExtraction.
    const spec = await loadSpec();
    const { paths, components } = spec;
    for (const path of ["/api/v1/assets", "/api/v1/assets/{id}"]) {
      const params = paramsOf(spec, paths[path].post);
      expect(params.find((p) => p.name === "Content-Encoding")?.schema, path).toEqual({ $ref: "#/components/schemas/ContentEncoding" });
      expect(params.find((p) => p.name === "X-Skip-Extraction")?.schema, path).toEqual({ $ref: "#/components/schemas/XSkipExtraction" });
    }
    expect(components.schemas).toHaveProperty("ContentEncoding");
    expect(components.schemas).toHaveProperty("XSkipExtraction");
  });

  test("declares every tag an operation uses", async () => {
    const spec = await loadSpec() as Spec & { tags: { name: string }[] };
    const declared = new Set(spec.tags.map((t) => t.name));
    const used = new Set(Object.values(spec.paths).flatMap((ops) => Object.values(ops).flatMap((op) => (op as { tags?: string[] }).tags ?? [])));
    expect([...used].filter((t) => !declared.has(t))).toEqual([]);
  });

  test("documents the health check", async () => {
    const spec = await loadSpec();
    const op = spec.paths["/api/v1/health"]?.get as Operation & { responses: Record<string, { content: Record<string, { schema: unknown }> }> };
    expect(op.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/HealthResponse" });
    expect(spec.components.schemas).toHaveProperty("HealthResponse");
  });

  test("shows both upload session shapes and the NDJSON listing by example", async () => {
    type Media = { examples?: Record<string, { value: unknown }> };
    const { paths } = await loadSpec() as unknown as { paths: Record<string, Record<string, { requestBody?: { content: Record<string, Media> }; responses: Record<string, { content?: Record<string, Media> }> }>> };
    const create = paths["/api/v1/assets/uploads"].post;
    expect(Object.keys(create.requestBody?.content["application/json"].examples ?? {})).toEqual(["single", "declared", "multipart"]);
    expect(Object.keys(create.responses["201"].content?.["application/json"].examples ?? {})).toEqual(["single", "declared", "multipart"]);
    expect(paths["/api/v1/assets/uploads/{id}/complete"].post.requestBody?.content["application/json"].examples).toHaveProperty("multipart");
    const ndjson = paths["/api/v1/assets/{id}/files"].get.responses["200"].content?.["application/x-ndjson"].examples ?? {};
    expect(typeof ndjson.archive?.value).toBe("string");
  });

  test("names no product in its title", async () => {
    const spec = await loadSpec() as Spec & { info: { title: string } };
    expect(spec.info.title).toBe("Serve API");
  });

  test.each([
    ["/api/v1/workspaces", "post"],
    ["/api/v1/workspaces/{id}", "delete"],
    ["/api/v1/workspaces/{id}/members", "post"],
    ["/api/v1/workspaces/{id}/members/{userId}", "patch"],
    ["/api/v1/workspaces/{id}/members/{userId}", "delete"],
  ])("%s %s declares 405 for an external directory", async (path, method) => {
    expect((await loadSpec()).paths[path][method].responses).toHaveProperty("405");
  });

  test("every route that binds the caller declares 503, and no other route does", async () => {
    const { paths } = await loadSpec();
    const declares = (path: string) =>
      Object.values(paths[path]).every((op) => "503" in op.responses);
    const bound = Object.keys(paths).filter((p) => p.startsWith("/api/v1/") && !["/api/v1/health", "/api/v1/doc", "/api/v1/docs"].includes(p));
    expect(bound.length).toBeGreaterThan(0);
    for (const path of bound) expect(declares(path), path).toBe(true);
    // /files binds no caller. Its own 503 is a password-protection misconfiguration.
    expect(paths["/files/{id}/{path}"].get.responses["503"]).not.toEqual({ $ref: "#/components/responses/TenancyUnavailable" });
  });

  test("documents public file delivery without auth", async () => {
    const spec = await loadSpec();
    const op = spec.paths["/files/{id}/{path}"]?.get;
    expect(op).toBeDefined();
    expect(op.security).toEqual([]);
    expect(paramsOf(spec, op).map((p) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["path:id", "path:path", "query:thumb", "header:Range", "header:Accept-Encoding", "header:If-None-Match"]),
    );
    expect(Object.keys(op.responses).sort()).toEqual(["200", "206", "301", "304", "400", "401", "404", "429", "503"]);
  });
});
