import { describe, test, expect, beforeAll } from "vitest";
import { BASE, uploadFile } from "./helpers";

// 100×100 solid-red JPEG, generated offline via `sips -s format jpeg`. Kept
// inline so the test has no runtime image-encoding dependency.
//
// JPEG (not PNG) is used because jSquash's PNG codec does not reliably
// load in wrangler dev's Vite environment — the same code paths work in
// production. The end-to-end pipeline (queue → generator → R2 → delivery)
// is exercised regardless of which format the source uses.
function tinyImage(): { bytes: Uint8Array; filename: string; contentType: string } {
  const b64 =
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6AB" +
    "AAMAAAABAAEAAKACAAQAAAABAAAAZKADAAQAAAABAAAAZAAAAAD/wAARCABkAGQDASIAAhEBAxEB/8QA" +
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIh" +
    "MUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW" +
    "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQF" +
    "BgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAV" +
    "YnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE" +
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq" +
    "8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwM" +
    "DAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
    "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAH/9oADAMBAAIRAxEAPwD4vooor+Uz/fwKKKKACiii" +
    "gAooooAKKKKACiiigAooooA//9D4vooor+Uz/fwKKKKACiiigAooooAKKKKACiiigAooooA//9H4vooo" +
    "r+Uz/fwKKKKACiiigAooooAKKKKACiiigAooooA//9L4vooor+Uz/fwKKKKACiiigAooooAKKKKACiii" +
    "gAooooA//9P4vooor+Uz/fwKKKKACiiigAooooAKKKKACiiigAooooA//9T4vooor+Uz/fwKKKKACiii" +
    "gAooooAKKKKACiiigAooooA//9X4vooor+Uz/fwKKKKACiiigAooooAKKKKACiiigAooooA//9k=";
  return {
    bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    filename: "tiny.jpg",
    contentType: "image/jpeg",
  };
}

// WebP signature: bytes 0-3 "RIFF", bytes 8-11 "WEBP".
function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}

async function pollThumbnail(url: string, timeoutMs = 30000): Promise<Response> {
  const start = Date.now();
  let lastStatus = 0;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(url);
    if (res.status === 200) return res;
    lastStatus = res.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Thumbnail did not become available within ${timeoutMs}ms (last status: ${lastStatus}): ${url}`);
}

describe("Thumbnail generation and delivery", () => {
  let assetId: string;

  let sourceFilename: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    const src = tinyImage();
    const upload = await uploadFile(src.bytes, src.filename, src.contentType);
    expect(upload.status).toBe(201);
    assetId = upload.body.asset.id;
    sourceFilename = src.filename;
  });

  test("path form: /files/:id/_thumbs/xs.webp returns generated WebP", async () => {
    const res = await pollThumbnail(`${BASE}/files/${assetId}/_thumbs/xs.webp`);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(isWebp(bytes)).toBe(true);
  });

  test("query form: ?thumb=xs returns the same thumbnail", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/${sourceFilename}?thumb=xs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(isWebp(bytes)).toBe(true);
  });

  test("invalid query value returns 400", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/${sourceFilename}?thumb=xxl`);
    expect(res.status).toBe(400);
  });

  test("invalid path size returns 400 too", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/_thumbs/xxl.webp`);
    expect(res.status).toBe(400);
  });

  test("non-image asset has no thumbnail (404)", async () => {
    const txt = await uploadFile(new TextEncoder().encode("hi"), "note.txt", "text/plain");
    expect(txt.status).toBe(201);
    const otherId = txt.body.asset.id;

    // Give the queue a moment to skip it; the consumer's isThumbnailableContentType
    // gate means no R2 write ever happens.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${BASE}/files/${otherId}/_thumbs/xs.webp`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toContain("max-age=30");
  });

  test("thumbnail response has immutable cache headers", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/_thumbs/xs.webp`);
    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });
});
