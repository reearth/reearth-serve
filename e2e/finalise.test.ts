import { request as httpRequest } from "node:http";
import { describe, expect, test } from "vitest";
import { writeZip } from "../adapters/memory/zip";
import { BASE, buildMiniZip, rawGet, uploadFile } from "./helpers";

const SUFFIX = process.env.E2E_SITE_HOST_SUFFIX;
const encoder = new TextEncoder();

// A central directory of about 1.3 MB, beyond the 1 MiB tail read, so finalisation builds an index.
function indexedZip(extra: Record<string, string> = {}): Uint8Array {
  const entries = Array.from({ length: 10_000 }, (_, i) => ({
    name: `tiles/${String(i).padStart(8, "0")}/${"n".repeat(64)}.json`,
    data: encoder.encode(`{"i":${i}}`),
  }));
  for (const [name, text] of Object.entries(extra)) entries.push({ name, data: encoder.encode(text) });
  return writeZip(entries);
}

const sessionHeaders = (sessionId: string | null): Record<string, string> => (sessionId ? { "X-Session-Id": sessionId } : {});

function hostGet(host: string, path: string): Promise<{ status: number; location?: string }> {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: base.hostname, port: base.port, path, method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Upload finalisation (ADR-018 P3)", { timeout: 60_000 }, () => {
  test("a single PUT of a large zip records its container index in the asset meta", async () => {
    const { status, body, sessionId } = await uploadFile(indexedZip(), "city.zip", "application/zip");
    expect(status).toBe(201);
    const id = body.asset.id as string;
    const expected = { index: `assets/${id}/_archive/container.v1`, rootPrefix: "" };
    expect(body.asset.container).toMatchObject(expected);

    const res = await fetch(`${BASE}/api/v1/assets/${id}`, { headers: sessionHeaders(sessionId) });
    expect((await res.json() as any).asset.container).toMatchObject(expected);

    const entry = await rawGet(`${BASE}/files/${id}/tiles/00004321/${"n".repeat(64)}.json`);
    expect(entry.status).toBe(200);
    expect(new TextDecoder().decode(entry.body)).toBe('{"i":4321}');
  });

  test("a version upload records the index in the version meta, under the version's root", async () => {
    const first = await uploadFile(buildMiniZip({ "a.txt": "v1" }), "city.zip", "application/zip");
    const id = first.body.asset.id as string;
    const headers = sessionHeaders(first.sessionId);
    expect(first.body.asset.container).toMatchObject({ skipped: "small" });

    const bytes = indexedZip();
    const res = await fetch(`${BASE}/api/v1/assets/${id}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip", "Content-Length": String(bytes.byteLength), "X-Filename": "city.zip" },
      body: bytes as BodyInit,
    });
    expect(res.status).toBe(201);
    const versionId = (await res.json() as any).version.id as string;

    const version = await (await fetch(`${BASE}/api/v1/assets/${id}/versions/${versionId}`, { headers })).json() as any;
    expect(version.version.container).toMatchObject({ index: `assets/${id}/v/${versionId}/_archive/container.v1` });
    const asset = await (await fetch(`${BASE}/api/v1/assets/${id}`, { headers })).json() as any;
    expect(asset.asset.container).toMatchObject({ skipped: "small" });
  });

  test("a tiny zip records skipped small", async () => {
    const { status, body } = await uploadFile(buildMiniZip({ "index.html": "<p>hi</p>" }), "tiny.zip", "application/zip");
    expect(status).toBe(201);
    expect(body.asset.container).toMatchObject({ skipped: "small", rootPrefix: "" });
    expect(body.asset.container.index).toBeUndefined();
  });

  test("a site zip's _redirects is parsed at upload, before extraction", async () => {
    const zip = indexedZip({ "index.html": "<p>home</p>", "docs/index.html": "<p>docs</p>", "_redirects": "/old /docs/ 301\n" });
    const { status, body } = await uploadFile(zip, "site.zip", "application/zip");
    expect(status).toBe(201);
    expect(body.asset.status).toBe("pending");
    expect(body.asset.hosting.redirects).toEqual([expect.objectContaining({ from: "/old", to: "/docs/", status: 301 })]);
  });

  test.skipIf(!SUFFIX)("the parsed redirect applies on the site host right after upload", async () => {
    const zip = indexedZip({ "index.html": "<p>home</p>", "docs/index.html": "<p>docs</p>", "_redirects": "/old /docs/ 301\n" });
    const { body } = await uploadFile(zip, "site.zip", "application/zip");
    const moved = await hostGet(`${body.asset.id}${SUFFIX}`, "/old");
    expect(moved.status).toBe(301);
    expect(moved.location).toContain("/docs/");
  });
});
