// Upload integrity end to end through the real routes, SQLite stores (with
// migration 0008) and the in-memory object store (ADR-017 §1–§2, phase P1a).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../../core/app";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let sessionId: string;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

async function upload(path: string, body: Uint8Array, filename: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    body: body as BodyInit,
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(body.byteLength),
      "X-Filename": filename,
      ...(sessionId && { "X-Session-Id": sessionId }),
      ...headers,
    },
  }));
}

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers: sessionId ? { "X-Session-Id": sessionId } : {} }));
}

const storage = () => runtime.deps.storage as MemoryFileStorage;

async function assetCount(): Promise<number> {
  return (await runtime.deps.metadata.list({ scope: { kind: "session", sessionId } })).items.length;
}

beforeEach(async () => {
  runtime = buildNodeRuntime({ ANONYMOUS_UPLOAD_ENABLED: "true" });
  app = createApp(runtime.deps);
  sessionId = "";
  // Mint a session so later uploads and reads share one scope.
  const first = await upload("/api/v1/assets", bytes("seed"), "seed.txt");
  expect(first.status).toBe(201);
  sessionId = first.headers.get("X-Session-Id")!;
});

describe("POST /api/v1/assets with X-Content-SHA256", () => {
  test("a malformed header is 400 and stores nothing", async () => {
    const before = storage().size;
    for (const value of ["abc", "g".repeat(64), "a".repeat(65)]) {
      const res = await upload("/api/v1/assets", bytes("hello"), "a.txt", { "X-Content-SHA256": value });
      expect(res.status, value).toBe(400);
    }
    expect(storage().size).toBe(before);
    expect(await assetCount()).toBe(1);
  });

  test("a matching declared hash (any case) is recorded lowercase as verified", async () => {
    const body = bytes("hello");
    const res = await upload("/api/v1/assets", body, "a.txt", { "X-Content-SHA256": sha256(body).toUpperCase() });
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as { asset: { id: string; sha256: string; integrity: string } };
    expect(asset).toMatchObject({ sha256: sha256(body), integrity: "verified" });

    // The ledger row round-trips through SQLite.
    const read = ((await (await get(`/api/v1/assets/${asset.id}`)).json()) as { asset: object }).asset;
    expect(read).toMatchObject({ sha256: sha256(body), integrity: "verified" });

    const file = await get(`/files/${asset.id}/a.txt`);
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256(body));
  });

  test("a mismatched declared hash is 422 with no object and no row", async () => {
    const before = storage().size;
    const res = await upload("/api/v1/assets", bytes("hello"), "a.txt", { "X-Content-SHA256": sha256(bytes("other")) });
    expect(res.status).toBe(422);
    expect(storage().size).toBe(before);
    expect(await assetCount()).toBe(1);
  });

  test("without a declaration Serve hashes the body and records it", async () => {
    const body = bytes("undeclared body");
    const res = await upload("/api/v1/assets", body, "a.txt");
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as { asset: { sha256: string; integrity: string } };
    expect(asset).toMatchObject({ sha256: sha256(body), integrity: "verified" });
  });
});

describe("POST /api/v1/assets/:id (new version) with X-Content-SHA256", () => {
  let assetId: string;

  beforeEach(async () => {
    const res = await upload("/api/v1/assets", bytes("v1"), "a.txt");
    assetId = ((await res.json()) as { asset: { id: string } }).asset.id;
  });

  test("a matching declared hash is recorded on the version", async () => {
    const body = bytes("v2 body");
    const res = await upload(`/api/v1/assets/${assetId}`, body, "a.txt", { "X-Content-SHA256": sha256(body) });
    expect(res.status).toBe(201);
    const { version } = (await res.json()) as { version: { id: string; sha256: string; integrity: string } };
    expect(version).toMatchObject({ sha256: sha256(body), integrity: "verified" });

    const read = (await (await get(`/api/v1/assets/${assetId}/versions/${version.id}`)).json()) as { version: { sha256: string } };
    expect(read.version.sha256).toBe(sha256(body));
    const file = await get(`/files/${version.id}/a.txt`);
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256(body));
  });

  test("a mismatch is 422 and creates no version", async () => {
    const before = storage().size;
    const res = await upload(`/api/v1/assets/${assetId}`, bytes("v2 body"), "a.txt", { "X-Content-SHA256": "0".repeat(64) });
    expect(res.status).toBe(422);
    expect(storage().size).toBe(before);
    expect(await runtime.deps.versions.count(assetId)).toBe(0);
  });

  test("a malformed header is 400", async () => {
    const res = await upload(`/api/v1/assets/${assetId}`, bytes("v2"), "a.txt", { "X-Content-SHA256": "nope" });
    expect(res.status).toBe(400);
  });

  test("without a declaration the version records the computed hash", async () => {
    const body = bytes("v2 undeclared");
    const res = await upload(`/api/v1/assets/${assetId}`, body, "a.txt");
    const { version } = (await res.json()) as { version: { sha256: string; integrity: string } };
    expect(version).toMatchObject({ sha256: sha256(body), integrity: "verified" });
  });
});
