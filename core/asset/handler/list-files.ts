import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { originalKey } from "../../blob/model";
import { getAssetMetadata } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { fileListExamples } from "../../openapi-examples";
import { fileEntrySchema, idParamSchema, fileListQuerySchema } from "../../../shared/openapi";
import { jsonError } from "../../openapi";

export function registerListFilesRoute(app: Hono<AppEnv>) {
  app.get("/:id/files",
    describeRoute({
      tags: ["Assets"],
      summary: "List files in asset (NDJSON stream)",
      description: "Returns a stream of newline-delimited JSON (`application/x-ndjson`): one `FileEntry` object per line, each terminated by `\\n`. The schema below describes a single line. Read the body line by line rather than as one JSON document.",
      responses: {
        200: { description: "NDJSON stream of file entries", content: { "application/x-ndjson": { schema: resolver(fileEntrySchema), examples: fileListExamples } } },
        404: jsonError("Asset not found"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("query", fileListQuerySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const storage = c.get("storage");
      const { id } = c.req.valid("param");
      const { prefix: prefixParam } = c.req.valid("query");
      const prefix = prefixParam || "";

    const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "read_asset");
    if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
    const asset = access.value;

    // Body framing is the runtime's business, not ours: an explicit
    // `Transfer-Encoding: chunked` next to the empty-string bodies below makes
    // Node emit both that header and `Content-Length: 0`, which is not valid
    // HTTP/1.1 and undici refuses to parse. Workers already chunks a streaming
    // body on its own, so dropping the header changes nothing there.
    const ndjsonHeaders = {
      "Content-Type": "application/x-ndjson",
    };
    const encoder = new TextEncoder();

    // Non-archive asset: emit single entry
    if (asset.type !== "archive") {
      if (!prefix || asset.filename.startsWith(prefix)) {
        // Get ETag from storage for hash
        const head = await storage.head(originalKey(asset));
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
