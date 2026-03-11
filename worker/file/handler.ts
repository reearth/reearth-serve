import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";

export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

// GET /files/:id/:filename — serve single-file asset
// GET /files/:id/path/to/file — serve extracted file from archive asset
fileRoutes.get("/:id/:path{.+}", async (c) => {
  const metadataStore = c.get("metadata");
  const storage = c.get("storage");
  const id = c.req.param("id");
  const filePath = c.req.param("path");
  const rangeHeader = c.req.header("Range");
  const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
  const clientAcceptsGzip = acceptEncoding.includes("gzip");
  const range = parseRange(rangeHeader);

  const asset = await metadataStore.find(id);
  if (!asset) {
    return c.json({ error: "File not found" }, 404);
  }

  // Determine storage key and content info based on asset type
  const isArchiveSubpath = asset.type === "archive" && filePath !== asset.filename;
  const storageKeyPath = isArchiveSubpath
    ? `assets/${id}/files/${filePath}`
    : `assets/${id}/${asset.filename}`;

  const file = await storage.get(storageKeyPath, undefined);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  const contentType = isArchiveSubpath ? file.contentType : asset.contentType;
  const contentEncoding = isArchiveSubpath ? file.contentEncoding : asset.contentEncoding;
  const displayName = isArchiveSubpath ? filePath.split("/").pop() || filePath : asset.filename;
  const isGzipStored = contentEncoding === "gzip";

  // --- Non-gzip file ---
  if (!isGzipStored) {
    if (range) {
      const rangedFile = await storage.get(storageKeyPath, range);
      if (!rangedFile) return c.json({ error: "File not found" }, 404);

      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600, immutable",
        "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
      };

      if (rangedFile.range) {
        const { offset, length, totalSize } = rangedFile.range;
        headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${totalSize}`;
        headers["Content-Length"] = String(length);
        return new Response(rangedFile.body, { status: 206, headers });
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
      "Content-Length": String(file.size),
    };
    return new Response(file.body, { status: 200, headers });
  }

  // --- Gzip-stored + client accepts gzip + no range → pass through ---
  if (clientAcceptsGzip && !rangeHeader) {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
    };
    return new Response(file.body, { status: 200, headers });
  }

  // --- Gzip-stored: decompress ---
  const decompressed = decompressStream(file.body);
  const originalSize = asset.originalSize;

  if (!range) {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
    };
    if (originalSize) headers["Content-Length"] = String(originalSize);
    return new Response(decompressed, { status: 200, headers });
  }

  // Range on gzip: decompress, skip to offset, stream the range
  const sliced = sliceStream(decompressed, range.offset, range.length, originalSize);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600, immutable",
    "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
  };

  if (originalSize) {
    const end = Math.min(range.offset + range.length, originalSize) - 1;
    const length = end - range.offset + 1;
    headers["Content-Range"] = `bytes ${range.offset}-${end}/${originalSize}`;
    headers["Content-Length"] = String(length);
  }

  return new Response(sliced, { status: 206, headers });
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

  return { offset: start, length: Number.MAX_SAFE_INTEGER };
}

function sliceStream(
  stream: ReadableStream<Uint8Array>,
  offset: number,
  length: number,
  totalSize?: number,
): ReadableStream<Uint8Array> {
  const actualLength = totalSize ? Math.min(length, totalSize - offset) : length;
  let skipped = 0;
  let sent = 0;

  return new ReadableStream({
    async start() {},
    async pull(controller) {
      const reader = (this as any)._reader ?? ((this as any)._reader = stream.getReader());

      while (sent < actualLength) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }

        const chunk = value;
        const chunkStart = skipped;
        const chunkEnd = skipped + chunk.length;

        if (chunkEnd <= offset) {
          skipped += chunk.length;
          continue;
        }

        const sliceStart = Math.max(0, offset - chunkStart);
        const remaining = actualLength - sent;
        const sliceEnd = Math.min(chunk.length, sliceStart + remaining);
        const slice = chunk.subarray(sliceStart, sliceEnd);

        controller.enqueue(slice);
        sent += slice.length;
        skipped += chunk.length;

        if (sent >= actualLength) {
          controller.close();
          reader.cancel();
          return;
        }
      }
    },
    cancel() {
      const reader = (this as any)._reader;
      if (reader) reader.cancel();
    },
  });
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

  test("sliceStream extracts correct range", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const input = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(data); c.close(); },
    });

    const sliced = sliceStream(input, 3, 4, 10);
    const reader = sliced.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    expect(result).toEqual(new Uint8Array([3, 4, 5, 6]));
  });

  test("sliceStream works with multiple chunks", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0, 1, 2]));
        c.enqueue(new Uint8Array([3, 4, 5]));
        c.enqueue(new Uint8Array([6, 7, 8, 9]));
        c.close();
      },
    });

    const sliced = sliceStream(input, 2, 5, 10);
    const reader = sliced.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    expect(result).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
  });
}
