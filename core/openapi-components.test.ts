import { expect, test } from "vitest";
import { generateSpecs } from "hono-openapi";
import { createApp } from "./app";
import { docOnlyDeps } from "./openapi.testing";

// Kept out of openapi.test.ts on purpose: vitest isolates modules per file, so
// here the routers start unresolved and the document cache starts empty.

test("keeps every $ref'd schema when the routes were already resolved", async () => {
  // Regression: hono-openapi converts route schemas in place and only collects
  // components from schemas it converts itself. With Vite HMR, app.ts reloaded
  // (empty cache) while the project/workspace/me route modules did not, so the
  // document kept their $refs but lost Project, Workspace and Member.
  // Resolving every route first, bypassing the cache, reproduces that state.
  await generateSpecs(createApp(docOnlyDeps()));

  const res = await createApp(docOnlyDeps()).request("/api/v1/doc");
  const spec = await res.json() as { components: Record<string, Record<string, unknown> | undefined> };

  // schemas, parameters, responses, ...
  const refs = new Set(
    [...JSON.stringify(spec).matchAll(/"#\/components\/(\w+)\/([^"]+)"/g)].map((m) => `${m[1]}/${m[2]}`),
  );
  expect(refs.size).toBeGreaterThan(0);
  const missing = [...refs].filter((ref) => {
    const [kind, name] = ref.split("/");
    return !spec.components[kind]?.[name];
  });
  expect(missing).toEqual([]);
});
