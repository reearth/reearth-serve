import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getAssetMetadata } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";

export function registerListFilesRoute(app: Hono<AppEnv>) {
  // GET /api/v1/assets/:id/files — list files in asset (NDJSON stream)
  // Query params: ?prefix=path/prefix
  app.get("/:id/files", async (c) => {
    const metadata = c.get("metadata");
    const storage = c.get("storage");
    const id = c.req.param("id");
    const prefix = c.req.query("prefix") || "";

    const asset = await getAssetMetadata(metadata, id);
    if (!asset || !await canAccessAsset(asset, accessCtx(c))) {
      return c.json({ error: "Asset not found" }, 404);
    }

    const ndjsonHeaders = {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
    };
    const encoder = new TextEncoder();

    // Non-archive asset: emit single entry
    if (asset.type !== "archive") {
      if (!prefix || asset.filename.startsWith(prefix)) {
        // Get ETag from storage for hash
        const storageKey = `assets/${id}/${asset.filename}`;
        const head = await storage.head(storageKey);
        const hash = head?.etag ? `md5:${head.etag.replace(/"/g, "")}` : undefined;
        const entry = { path: asset.filename, size: asset.size, contentType: asset.contentType, ...(hash && { hash }) };
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify(entry) + "\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: ndjsonHeaders });
      }
      // No match
      return new Response("", { status: 200, headers: ndjsonHeaders });
    }

    // Archive: stream manifest from R2, filtering by prefix
    const manifestKey = `assets/${id}/_archive/_manifest.jsonl`;
    const manifestFile = await storage.get(manifestKey);
    if (!manifestFile) {
      return new Response("", { status: 200, headers: ndjsonHeaders });
    }

    // Stream-transform: read manifest line by line, filter by prefix, forward
    const body = manifestFile.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(filterNdjsonByPrefix(prefix))
      .pipeThrough(new TextEncoderStream());

    return new Response(body, { status: 200, headers: ndjsonHeaders });
  });
}

export function filterNdjsonByPrefix(prefix: string): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) {
        if (!line) continue;
        if (!prefix) {
          controller.enqueue(line + "\n");
          continue;
        }
        try {
          const entry = JSON.parse(line) as { path: string };
          if (entry.path.startsWith(prefix)) {
            controller.enqueue(line + "\n");
          }
        } catch {
          // skip malformed lines
        }
      }
    },
    flush(controller) {
      if (!buffer) return;
      if (!prefix) {
        controller.enqueue(buffer + "\n");
        return;
      }
      try {
        const entry = JSON.parse(buffer) as { path: string };
        if (entry.path.startsWith(prefix)) {
          controller.enqueue(buffer + "\n");
        }
      } catch {
        // skip
      }
    },
  });
}
