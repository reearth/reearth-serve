// Upload integrity over HTTP (ADR-017 §1–§2, phase P1a), the blob layer
// that declared uploads are stored in (§3, P2), and deduplication inside a
// workspace (§4, P3). Runs against both
// runtimes: the R2 binding verifies a declared hash on Workers, the memory
// store does it in-process on Node.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { BASE, MOCK_OIDC, rewriteUrl, signToken } from "./helpers";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function upload(path: string, content: Uint8Array, filename: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(content.byteLength),
      "X-Filename": filename,
      ...headers,
    },
    body: content as BodyInit,
  });
}

describe("X-Content-SHA256 on direct uploads", () => {
  let sessionId: string;
  const body = new TextEncoder().encode("integrity e2e body");

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
    const first = await upload("/api/v1/assets", new TextEncoder().encode("seed"), "seed.txt");
    expect(first.status).toBe(201);
    sessionId = first.headers.get("X-Session-Id")!;
  });

  test("a declared hash is verified, recorded and served back", async () => {
    const res = await upload("/api/v1/assets", body, "declared.txt", {
      "X-Session-Id": sessionId,
      "X-Content-SHA256": sha256(body).toUpperCase(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { asset: { id: string; sha256: string; integrity: string }; url: string };
    expect(json.asset.sha256).toBe(sha256(body));
    expect(json.asset.integrity).toBe("verified");

    const file = await fetch(rewriteUrl(json.url));
    expect(file.status).toBe(200);
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256(body));
    expect(file.headers.get("Access-Control-Expose-Headers")).toContain("X-Content-SHA256");
    await file.arrayBuffer();
  });

  test("a mismatched hash is 422", async () => {
    const res = await upload("/api/v1/assets", body, "mismatch.txt", {
      "X-Session-Id": sessionId,
      "X-Content-SHA256": "0".repeat(64),
    });
    expect(res.status).toBe(422);
  });

  test("a malformed hash is 400", async () => {
    const res = await upload("/api/v1/assets", body, "malformed.txt", {
      "X-Session-Id": sessionId,
      "X-Content-SHA256": "not-a-hash",
    });
    expect(res.status).toBe(400);
  });

  test("without a declaration the server records the hash it computed", async () => {
    const res = await upload("/api/v1/assets", body, "undeclared.txt", { "X-Session-Id": sessionId });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { asset: { id: string; sha256: string; integrity: string } };
    expect(json.asset.sha256).toBe(sha256(body));
    expect(json.asset.integrity).toBe("verified");

    const version = await upload(`/api/v1/assets/${json.asset.id}`, body, "undeclared.txt", { "X-Session-Id": sessionId });
    expect(version.status).toBe(201);
    const v = (await version.json()) as { version: { sha256: string; integrity: string } };
    expect(v.version).toMatchObject({ sha256: sha256(body), integrity: "verified" });
  });
});

// The blob layer (ADR-017 §3, P2): declared uploads in one workspace share
// their bytes, invisibly. Needs a workspace, so a real login.
let mockOidcAvailable = false;
try {
  mockOidcAvailable = (await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`)).ok;
} catch {
  // not reachable
}

describe("declared uploads in one workspace", { skip: !mockOidcAvailable }, () => {
  let token: string;
  let projectId: string;
  const body = new TextEncoder().encode(`identical declared content ${Date.now()}`);

  async function api(method: string, path: string, json?: unknown): Promise<Response> {
    return fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(json !== undefined && { "Content-Type": "application/json" }) },
      ...(json !== undefined && { body: JSON.stringify(json) }),
    });
  }

  beforeAll(async () => {
    token = await signToken({ sub: "e2e-blob-user" });
    const ws = (await (await api("POST", "/workspaces", { name: "e2e-blobs" })).json()) as { workspace: { id: string } };
    const project = await api("POST", "/projects", { name: "e2e-blobs", workspaceId: ws.workspace.id });
    expect(project.status).toBe(201);
    projectId = ((await project.json()) as { project: { id: string } }).project.id;
  });

  test("two assets with identical declared content: deleting one leaves the other serving at its URL", async () => {
    const headers = { Authorization: `Bearer ${token}`, "X-Project-Id": projectId, "X-Content-SHA256": sha256(body) };
    const a = await upload("/api/v1/assets", body, "a.txt", headers);
    const b = await upload("/api/v1/assets", body, "b.txt", headers);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const first = (await a.json()) as { asset: Record<string, unknown> & { id: string }; url: string };
    const second = (await b.json()) as { asset: Record<string, unknown> & { id: string }; url: string };
    // Same response shape as any upload; nothing says where the bytes live.
    expect(first.asset).not.toHaveProperty("blobKey");
    expect(new URL(second.url).pathname).toBe(`/files/${second.asset.id}/b.txt`);

    expect((await api("DELETE", `/assets/${first.asset.id}`)).status).toBe(204);

    const file = await fetch(rewriteUrl(second.url));
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(body);
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256(body));
    expect((await fetch(rewriteUrl(first.url))).status).toBe(404);
  });

  test("bytes already in the workspace: same response for a duplicate, and an empty body creates a version", async () => {
    const content = new TextEncoder().encode(`dedup e2e ${Date.now()}`);
    const headers = { Authorization: `Bearer ${token}`, "X-Project-Id": projectId, "X-Content-SHA256": sha256(content) };
    const first = (await (await upload("/api/v1/assets", content, "d.txt", headers)).json()) as { asset: Record<string, unknown> & { id: string } };
    const dupRes = await upload("/api/v1/assets", content, "d.txt", headers);
    expect(dupRes.status).toBe(201);
    const dup = (await dupRes.json()) as { asset: Record<string, unknown> & { id: string } };
    const strip = ({ id: _i, createdAt: _c, ...rest }: Record<string, unknown>) => rest;
    expect(strip(dup.asset)).toEqual(strip(first.asset));

    // No body at all: the version is made from the stored bytes.
    const v = await upload(`/api/v1/assets/${first.asset.id}`, new Uint8Array(0), "d.txt", headers);
    expect(v.status).toBe(201);
    const { version } = (await v.json()) as { version: { id: string; size: number; sha256: string; integrity: string } };
    expect(version).toMatchObject({ size: content.byteLength, sha256: sha256(content), integrity: "verified" });
    const file = await fetch(`${BASE}/files/${version.id}/d.txt`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(content);

    // An empty body naming bytes the workspace does not hold is just a mismatch.
    const unknown = sha256(new TextEncoder().encode(`not uploaded ${Date.now()}`));
    const miss = await upload(`/api/v1/assets/${first.asset.id}`, new Uint8Array(0), "d.txt", { ...headers, "X-Content-SHA256": unknown });
    expect(miss.status).toBe(422);
  });
});
