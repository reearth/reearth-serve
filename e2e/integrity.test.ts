// Upload integrity over HTTP (ADR-017 §1–§2, phase P1a). Runs against both
// runtimes: the R2 binding verifies a declared hash on Workers, the memory
// store does it in-process on Node.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { BASE, rewriteUrl } from "./helpers";

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
