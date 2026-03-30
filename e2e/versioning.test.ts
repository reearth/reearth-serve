import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE, rewriteUrl, uploadFile } from "./helpers";

/** Helper: fetch with session header */
async function fetchWithSession(path: string, sessionId: string, init?: RequestInit) {
  const headers = { "X-Session-Id": sessionId, ...init?.headers };
  return fetch(`${BASE}${path}`, { ...init, headers });
}

/** Helper: upload a new version to an existing asset */
async function uploadVersion(
  assetId: string,
  content: Uint8Array,
  filename: string,
  contentType: string,
  sessionId: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(content.byteLength),
      "X-Filename": filename,
      "X-Session-Id": sessionId,
    },
    body: content as BodyInit,
  });
  return { status: res.status, body: await res.json() };
}

describe("Asset Versioning", () => {
  let sessionId: string;
  let assetId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  // --- Create initial asset ---

  test("Upload initial asset", async () => {
    const result = await uploadFile(
      new TextEncoder().encode("version 1 content"),
      "data.txt",
      "text/plain",
    );
    expect(result.status).toBe(201);
    assetId = result.body.asset.id;
    sessionId = result.sessionId!;
  });

  // --- Upload new version ---

  test("POST /api/v1/assets/:id uploads a new version", async () => {
    const result = await uploadVersion(
      assetId,
      new TextEncoder().encode("version 2 content"),
      "data.txt",
      "text/plain",
      sessionId,
    );
    expect(result.status).toBe(201);
    expect(result.body.version).toBeDefined();
    expect(result.body.version.assetId).toBe(assetId);
    expect(result.body.version.version).toBe(1);
    expect(result.body.version.filename).toBe("data.txt");
    expect(result.body.version.size).toBe(new TextEncoder().encode("version 2 content").byteLength);
    expect(result.body.url).toContain(`/files/${assetId}/`);
  });

  test("Upload a third version", async () => {
    const result = await uploadVersion(
      assetId,
      new TextEncoder().encode("version 3 content"),
      "data-v3.txt",
      "text/plain",
      sessionId,
    );
    expect(result.status).toBe(201);
    expect(result.body.version.version).toBe(2);
    expect(result.body.version.filename).toBe("data-v3.txt");
  });

  // --- List versions ---

  test("GET /api/v1/assets/:id/versions lists versions (newest first)", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions`, sessionId);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.versions).toHaveLength(2);
    // Newest first
    expect(body.versions[0].version).toBe(2);
    expect(body.versions[1].version).toBe(1);
  });

  test("List versions with pagination", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions?limit=1`, sessionId);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.versions).toHaveLength(1);
    expect(body.cursor).toBeDefined();

    // Fetch page 2
    const res2 = await fetchWithSession(`/api/v1/assets/${assetId}/versions?limit=1&cursor=${body.cursor}`, sessionId);
    const body2 = await res2.json() as any;
    expect(body2.versions).toHaveLength(1);
    expect(body2.versions[0].version).not.toBe(body.versions[0].version);
  });

  // --- Get version ---

  let versionId1: string;
  let versionId2: string;

  test("GET /api/v1/assets/:id/versions/:versionId returns version metadata", async () => {
    // First get the version IDs
    const listRes = await fetchWithSession(`/api/v1/assets/${assetId}/versions`, sessionId);
    const listBody = await listRes.json() as any;
    versionId2 = listBody.versions[0].id; // v2 (newest)
    versionId1 = listBody.versions[1].id; // v1

    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions/${versionId1}`, sessionId);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.version.id).toBe(versionId1);
    expect(body.version.version).toBe(1);
    expect(body.version.assetId).toBe(assetId);
  });

  test("GET version returns 404 for non-existent version", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions/nonexistent`, sessionId);
    expect(res.status).toBe(404);
  });

  // --- Update version ---

  test("PATCH /api/v1/assets/:id/versions/:versionId updates userMeta", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions/${versionId1}`, sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ userMeta: { note: "first upload" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.version.userMeta).toEqual({ note: "first upload" });
  });

  // --- Get asset shows currentVersion and versionCount ---

  test("GET /api/v1/assets/:id includes currentVersion and versionCount", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}`, sessionId);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.asset.versionCount).toBe(2);
    expect(body.asset.currentVersion).toBeDefined();
    // Latest version (v2) should be current since no active version is set
    expect(body.asset.currentVersion.version).toBe(2);
  });

  // --- Update asset ---

  test("PATCH /api/v1/assets/:id updates description and userMeta", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}`, sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({
        description: "Test dataset",
        userMeta: { department: "engineering" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.asset.description).toBe("Test dataset");
    expect(body.asset.userMeta).toEqual({ department: "engineering" });
  });

  // --- Set active version ---

  test("PUT /api/v1/assets/:id/active-version sets a specific version", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/active-version`, sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ versionId: versionId1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.asset.activeVersionId).toBe(versionId1);
    expect(body.asset.currentVersion.id).toBe(versionId1);
  });

  test("PUT /api/v1/assets/:id/active-version with null resets to latest", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/active-version`, sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ versionId: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // activeVersionId should be cleared (null in JSON)
    expect(body.asset.activeVersionId).toBeNull();
    // currentVersion should be latest (v2)
    expect(body.asset.currentVersion.version).toBe(2);
  });

  test("PUT /api/v1/assets/:id/active-version with invalid versionId returns 404", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/active-version`, sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ versionId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  // --- File serving with versions ---

  test("File served via versioned R2 key for latest version", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/data-v3.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("version 3 content");
  });

  test("Setting active version changes which file is served", async () => {
    // Set active to v1
    await fetchWithSession(`/api/v1/assets/${assetId}/active-version`, sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ versionId: versionId1 }),
    });

    // File served should be v1's file
    const res = await fetch(`${BASE}/files/${assetId}/data.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("version 2 content");

    // Reset to latest
    await fetchWithSession(`/api/v1/assets/${assetId}/active-version`, sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ versionId: null }),
    });
  });

  test("File can be served by version ID directly", async () => {
    const res = await fetch(`${BASE}/files/${versionId1}/data.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("version 2 content");
  });

  // --- Delete version ---

  test("DELETE /api/v1/assets/:id/versions/:versionId deletes a version", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}/versions/${versionId1}`, sessionId, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    // Verify it's gone
    const getRes = await fetchWithSession(`/api/v1/assets/${assetId}/versions/${versionId1}`, sessionId);
    expect(getRes.status).toBe(404);

    // Only 1 version left
    const listRes = await fetchWithSession(`/api/v1/assets/${assetId}/versions`, sessionId);
    const listBody = await listRes.json() as any;
    expect(listBody.versions).toHaveLength(1);
    expect(listBody.versions[0].id).toBe(versionId2);
  });

  // --- Delete asset cleans up all versions ---

  test("DELETE /api/v1/assets/:id removes asset and all versions", async () => {
    const res = await fetchWithSession(`/api/v1/assets/${assetId}`, sessionId, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    // Asset gone
    const getRes = await fetchWithSession(`/api/v1/assets/${assetId}`, sessionId);
    expect(getRes.status).toBe(404);
  });

  // --- Upload to non-existent asset returns 404 ---

  test("POST version to non-existent asset returns 404", async () => {
    const result = await uploadVersion(
      "nonexistent",
      new TextEncoder().encode("oops"),
      "data.txt",
      "text/plain",
      sessionId,
    );
    expect(result.status).toBe(404);
  });
});

describe("Versioning CLI", () => {
  let tmpDir: string;
  let configDir: string;
  let assetId: string;
  let versionId: string;

  function cli(args: string): string {
    return execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} ${args}`,
      {
        encoding: "utf-8",
        env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir },
      },
    ).trim();
  }

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    tmpDir = mkdtempSync(join(tmpdir(), "serve-e2e-ver-"));
    configDir = mkdtempSync(join(tmpdir(), "serve-e2e-ver-config-"));
  });

  test("Upload initial asset via CLI", () => {
    const file = join(tmpDir, "v1.txt");
    writeFileSync(file, "cli version 1");
    const out = cli(`--json upload "${file}"`);
    const parsed = JSON.parse(out);
    assetId = parsed.asset.id;
    expect(assetId).toBeDefined();
  });

  test("CLI asset upload <id> <file> creates new version", () => {
    const file = join(tmpDir, "v2.txt");
    writeFileSync(file, "cli version 2");
    const out = cli(`--json asset upload ${assetId} "${file}"`);
    const parsed = JSON.parse(out);
    expect(parsed.version).toBeDefined();
    expect(parsed.version.assetId).toBe(assetId);
    expect(parsed.version.version).toBe(1);
    versionId = parsed.version.id;
  });

  test("CLI asset versions lists versions", () => {
    const out = cli(`asset versions ${assetId}`);
    expect(out).toContain("v1");
    expect(out).toContain(versionId);
  });

  test("CLI asset versions --json outputs JSON", () => {
    const out = cli(`--json asset versions ${assetId}`);
    const parsed = JSON.parse(out);
    expect(parsed.versions).toHaveLength(1);
    expect(parsed.versions[0].id).toBe(versionId);
  });

  test("CLI asset version show displays version details", () => {
    const out = cli(`asset version show ${assetId} ${versionId}`);
    expect(out).toContain(versionId);
    expect(out).toContain("v2.txt");
  });

  test("CLI asset version update sets userMeta", () => {
    const out = cli(`--json asset version update ${assetId} ${versionId} --user-meta '{"tag":"test"}'`);
    const parsed = JSON.parse(out);
    expect(parsed.version.userMeta).toEqual({ tag: "test" });
  });

  test("CLI asset update sets description", () => {
    const out = cli(`--json asset update ${assetId} --description "CLI test asset"`);
    const parsed = JSON.parse(out);
    expect(parsed.asset.description).toBe("CLI test asset");
  });

  test("CLI asset set-version sets active version", () => {
    const out = cli(`--json asset set-version ${assetId} --vid ${versionId}`);
    const parsed = JSON.parse(out);
    expect(parsed.asset.activeVersionId).toBe(versionId);
  });

  test("CLI asset set-version --latest resets to latest", () => {
    const out = cli(`--json asset set-version ${assetId} --latest`);
    const parsed = JSON.parse(out);
    expect(parsed.asset.activeVersionId).toBeFalsy();
  });

  test("CLI asset version delete removes a version", () => {
    const out = cli(`asset version delete ${assetId} ${versionId}`);
    expect(out).toContain("Deleted version");
  });

  test("CLI asset delete cleans up", () => {
    const out = cli(`asset delete ${assetId}`);
    expect(out).toContain("Deleted");
  });
});
