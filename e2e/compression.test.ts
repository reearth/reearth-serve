import { describe, test, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync, inflateRawSync } from "node:zlib";
import { BASE, rawGet, rewriteUrl, uploadFile } from "./helpers";

describe("Compression", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  test("Direct upload does NOT compress server-side (compression is client responsibility)", async () => {
    const data = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}` })) });
    const content = new TextEncoder().encode(data);
    expect(content.byteLength).toBeGreaterThan(1024);

    const { status, body } = await uploadFile(content, "large-data.json", "application/json");
    expect(status).toBe(201);
    // Server does NOT compress on direct upload
    expect(body.asset.contentEncoding).toBeUndefined();
    expect(body.asset.originalSize).toBeUndefined();
    expect(body.asset.size).toBe(content.byteLength);

    // Download returns original content as-is
    const fileUrl = rewriteUrl(body.url);
    const res = await fetch(fileUrl);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(data);
  });

  // Skipped in dev: Vite dev proxy rewrites Accept-Encoding to "br, gzip" (ignoring
  // the client's value) and strips Content-Encoding: gzip from the response while
  // leaving the body compressed. This means the gzip pass-through path always fires
  // but the client receives raw gzip bytes without the Content-Encoding header.
  // In production (workerd), the Worker controls headers directly, so this works correctly.
  test.skip("Direct upload with Content-Encoding: gzip stores as gzip and serves decompressed", async () => {
    const data = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}` })) });
    const original = new TextEncoder().encode(data);
    const compressed = new Uint8Array(gzipSync(original));

    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(compressed.byteLength),
        "Content-Encoding": "gzip",
        "X-Filename": "compressed.json",
        "X-Original-Size": String(original.byteLength),
      },
      body: compressed as BodyInit,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.asset.contentEncoding).toBe("gzip");
    expect(body.asset.originalSize).toBe(original.byteLength);
    expect(body.asset.size).toBe(compressed.byteLength);

    // Download — server decompresses or passes through gzip
    const fileUrl = rewriteUrl(body.url);
    const dlRes = await fetch(fileUrl);
    expect(dlRes.status).toBe(200);

    const dlBody = await dlRes.arrayBuffer();
    let text: string;
    if (dlRes.headers.get("Content-Encoding") === "gzip") {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(dlBody));
      writer.close();
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      text = new TextDecoder().decode(buf);
    } else {
      text = new TextDecoder().decode(dlBody);
    }
    expect(text).toBe(data);
  });

  test("CLI direct upload compresses compressible files", async () => {
    const { execSync } = await import("node:child_process");
    const { writeFileSync, unlinkSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const data = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i })) });
    const tmpFile = join(os.tmpdir(), "cli-compress-test.json");
    writeFileSync(tmpFile, data);

    // Isolated config dir: the default ~/.config/reearth-serve may hold real
    // credentials, which would turn this into an authenticated upload and be
    // rejected for lacking X-Project-Id.
    const configDir = mkdtempSync(join(os.tmpdir(), "serve-e2e-compress-config-"));

    try {
      const output = execSync(`npx tsx cli/index.ts --endpoint ${BASE} --json upload --direct "${tmpFile}"`, {
        encoding: "utf-8",
        env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir },
      });
      const result = JSON.parse(output);
      expect(result.asset.contentEncoding).toBe("gzip");
      expect(result.asset.originalSize).toBe(Buffer.byteLength(data));
    } finally {
      unlinkSync(tmpFile);
    }
  });

  test("Presigned upload session indicates compression for compressible files", async () => {
    // Create upload session — server should indicate gzip for compressible files
    const res = await fetch(`${BASE}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "data.json", contentType: "application/json", size: 5000 }),
    });

    // If presigned uploads are not available (no S3 creds), skip
    if (res.status === 501) return;

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.contentEncoding).toBe("gzip");
  });

  test("Presigned upload session does NOT indicate compression for small files", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "tiny.json", contentType: "application/json", size: 100 }),
    });

    if (res.status === 501) return;

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.contentEncoding).toBeUndefined();
  });

  test("Presigned upload session does NOT indicate compression for binary files", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "image.png", contentType: "image/png", size: 50000 }),
    });

    if (res.status === 501) return;

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.contentEncoding).toBeUndefined();
  });

  // Node only: under the Vite dev server undici decodes the body before the
  // test sees it (see e2e/archive.test.ts).
  test.skipIf(process.env.E2E_NODE_RUNTIME !== "true")("a deflate entry of a just-uploaded zip is one gzip member: header, the entry's raw deflate, trailer", async () => {
    const zip = new Uint8Array(readFileSync(new URL("../scripts/fixtures/zip/data/deflate.zip", import.meta.url)));
    const { status, body } = await uploadFile(zip, "deflate.zip", "application/zip");
    expect(status).toBe(201);
    const url = `${BASE}/files/${body.asset.id}/a.txt`;
    const plain = await rawGet(url);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["content-length"]).toBe("6600");

    const res = await rawGet(url, { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-length"]).toBe(String(res.body.byteLength));
    expect([...res.body.subarray(0, 3)]).toEqual([0x1f, 0x8b, 8]);
    expect(new Uint8Array(inflateRawSync(res.body.subarray(10, res.body.byteLength - 8)))).toEqual(plain.body);
    const decoded = await new Response(new Blob([res.body as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    expect(new Uint8Array(decoded)).toEqual(plain.body);
  });
});
