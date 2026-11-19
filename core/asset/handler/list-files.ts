import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { activeVersion, getAssetMetadata } from "../usecase";
import type { AssetMetadata, AssetVersion } from "../model";
import { openArchive, type ArchiveReader } from "../../archive";
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
      const prefix = c.req.valid("query").prefix || "";

    const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "read_asset");
    if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
    const asset = access.value;
    const layouts = listingLayouts(asset, await activeVersion(c.get("versions"), asset));

    // Body framing is the runtime's business, not ours: an explicit
    // `Transfer-Encoding: chunked` next to the empty-string bodies below makes
    // Node emit both that header and `Content-Length: 0`, which is not valid
    // HTTP/1.1 and undici refuses to parse. Workers already chunks a streaming
    // body on its own, so dropping the header changes nothing there.
    const ndjson = (body: BodyInit) => new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });

    if (!layouts[0].archive) {
      const layout = layouts[0];
      if (prefix && !layout.filename.startsWith(prefix)) return ndjson("");
      const head = await storage.head(`${layout.root}/${layout.filename}`);
      const hash = head?.etag ? `md5:${head.etag.replace(/"/g, "")}` : undefined;
      const entry = { path: layout.filename, size: layout.size, contentType: layout.contentType, ...(hash && { hash }) };
      return ndjson(JSON.stringify(entry) + "\n");
    }

    for (const layout of layouts.filter((l) => l.archive)) {
      const manifest = await storage.get(`${layout.root}/_archive/_manifest.jsonl`);
      if (manifest) {
        return ndjson(manifest.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(filterNdjsonByPrefix(prefix))
          .pipeThrough(new TextEncoderStream()));
      }
      if (layout.archiveFormat !== "zip") continue;
      const source = { key: `${layout.root}/${layout.filename}`, size: layout.size, filename: layout.filename };
      const opened = await openArchive({ storage, archives: c.get("archives") }, source);
      if (opened.ok) return ndjson(entryLines(opened.reader, prefix));
      console.warn(`list-files: ${source.key} is not listable in place (${opened.reason})`);
    }
    return ndjson("");
  });
}

interface ListingLayout {
  root: string;
  filename: string;
  size: number;
  contentType: string;
  archive: boolean;
  archiveFormat?: string;
}

function listingLayouts(asset: AssetMetadata, version: AssetVersion | null): ListingLayout[] {
  const layout = (root: string, row: AssetMetadata | AssetVersion): ListingLayout => ({
    root,
    filename: row.filename,
    size: row.size,
    contentType: row.contentType,
    archive: row.type === "archive",
    archiveFormat: row.archiveFormat,
  });
  const legacy = layout(`assets/${asset.id}`, asset);
  return version ? [layout(`assets/${asset.id}/v/${version.id}`, version), legacy] : [legacy];
}

const PAGE = 10_000;

function entryLines(reader: ArchiveReader, prefix: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let after: string | undefined;
  return new ReadableStream({
    async pull(controller) {
      const page = await reader.list({ prefix, after, limit: PAGE });
      const lines = page.entries
        .map((e) => JSON.stringify({ path: e.path, size: e.size, contentType: e.contentType, hash: `crc32:${e.crc32.toString(16).padStart(8, "0")}` }) + "\n")
        .join("");
      if (lines) controller.enqueue(encoder.encode(lines));
      if (page.next === undefined) controller.close();
      else after = page.next;
    },
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
