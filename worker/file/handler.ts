import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../types";
import { getAssetFile } from "../asset/usecase";

export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

// GET /files/:id/:filename — serve file content
fileRoutes.get("/:id/:filename", async (c) => {
  const metadata = c.get("metadata");
  const storage = c.get("storage");
  const id = c.req.param("id");

  // Parse Range header
  const rangeHeader = c.req.header("Range");
  const range = parseRange(rangeHeader);

  const result = await getAssetFile(metadata, storage, id, range ?? undefined);
  if (!result) {
    return c.json({ error: "File not found" }, 404);
  }

  const { asset, file } = result;

  const headers: Record<string, string> = {
    "Content-Type": asset.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600, immutable",
    "Content-Disposition": `inline; filename="${encodeURIComponent(asset.filename)}"`,
  };

  // Range response
  if (file.range) {
    const { offset, length, totalSize } = file.range;
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${totalSize}`;
    headers["Content-Length"] = String(length);
    return new Response(file.body, { status: 206, headers });
  }

  headers["Content-Length"] = String(file.size);
  return new Response(file.body, { status: 200, headers });
});

function parseRange(header: string | undefined): { offset: number; length: number } | null {
  if (!header) return null;

  const match = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;

  if (end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }

  // Open-ended range: bytes=100- (read from offset to end)
  // We use a large length; R2 will clamp to actual size
  return { offset: start, length: Number.MAX_SAFE_INTEGER };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("parseRange parses 'bytes=0-499'", () => {
    const r = parseRange("bytes=0-499");
    expect(r).toEqual({ offset: 0, length: 500 });
  });

  test("parseRange parses open-ended 'bytes=100-'", () => {
    const r = parseRange("bytes=100-");
    expect(r).not.toBeNull();
    expect(r!.offset).toBe(100);
  });

  test("parseRange returns null for no header", () => {
    expect(parseRange(undefined)).toBeNull();
  });

  test("parseRange returns null for invalid header", () => {
    expect(parseRange("invalid")).toBeNull();
  });
}
