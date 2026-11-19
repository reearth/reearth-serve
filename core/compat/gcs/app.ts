import { Hono, type Context } from "hono";
import type { Deps } from "../../types";
import { createHasher, base64Of, crc32cBase64, fromBase64 } from "../hash";
import { objectLayer, type ObjectLayerDeps } from "../layer";
import { MAX_LIST_RESULTS, type ListQuery } from "../list";
import { parseObjectKey, type ExactHashes, type PutMeta, type SizedBody } from "../model";
import { resumableUploads, type Chunk, type DeclaredHashes, type UploadStatus } from "../upload";
import { exchangeAssertion, gcsAuth, type GcsEnv, type TokenError } from "./auth";
import { boundaryOf, MULTIPART_MAX_BYTES, parseRelated, readCapped } from "./multipart";
import { compatErrorResponse, gcsError, listResource, objectResource, surfaceOf } from "./wire";

export type GcsDeps = ObjectLayerDeps & Pick<Deps, "signingSecret">;

/** The Go client sends every list parameter, so an empty value means the parameter is absent. */
function queryOf(c: Context<GcsEnv>, name: string): string | null {
  const value = c.req.query(name);
  return value === undefined || value === "" ? null : value;
}

const isTrue = (value: string | null) => value === "true";

function unsupportedListing(c: Context<GcsEnv>): string | null {
  const delimiter = queryOf(c, "delimiter");
  if (delimiter !== null && delimiter !== "/") return "delimiter other than /";
  if (queryOf(c, "matchGlob") !== null) return "matchGlob";
  for (const flag of ["versions", "includeTrailingDelimiter", "includeFoldersAsPrefixes", "softDeleted"]) {
    if (isTrue(queryOf(c, flag))) return flag;
  }
  return null;
}

function listQueryOf(c: Context<GcsEnv>): ListQuery | null {
  const raw = queryOf(c, "maxResults");
  if (raw !== null && !/^\d+$/.test(raw)) return null;
  const maxResults = raw === null ? MAX_LIST_RESULTS : Number(raw);
  if (maxResults < 1) return null;
  return {
    prefix: queryOf(c, "prefix") ?? "",
    delimiter: queryOf(c, "delimiter") === "/" ? "/" : null,
    startOffset: queryOf(c, "startOffset"),
    endOffset: queryOf(c, "endOffset"),
    pageToken: queryOf(c, "pageToken"),
    maxResults: Math.min(maxResults, MAX_LIST_RESULTS),
  };
}

const UNSUPPORTED_PRECONDITIONS = ["ifGenerationNotMatch", "ifMetagenerationMatch", "ifMetagenerationNotMatch"];

function generationMatchOf(c: Context<GcsEnv>): { ok: true; value: number | null } | { ok: false } {
  const raw = queryOf(c, "ifGenerationMatch");
  if (raw === null) return { ok: true, value: null };
  return /^\d+$/.test(raw) ? { ok: true, value: Number(raw) } : { ok: false };
}

type ObjectResource = {
  name?: unknown; contentType?: unknown; contentEncoding?: unknown; metadata?: unknown; crc32c?: unknown; md5Hash?: unknown;
};

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, v]) => typeof v === "string") ? Object.fromEntries(entries) as Record<string, string> : null;
}

const optionalString = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export function gcsApp(deps: GcsDeps, apiOrigin: string) {
  const app = new Hono<GcsEnv>();
  const tokenConfig = { apiOrigin, secret: deps.signingSecret };
  const layerOf = (c: Context<GcsEnv>) => objectLayer(deps, c.get("service"));
  const uploadsOf = (c: Context<GcsEnv>) => resumableUploads(deps, c.get("service"), layerOf(c));

  app.onError((err, c) => {
    console.error(err);
    if (c.req.path === "/token") {
      const body: TokenError = { error: "server_error", error_description: "The token endpoint failed." };
      return c.json(body, 500, { "Cache-Control": "no-store" });
    }
    return gcsError(surfaceOf(c.req.path), "backend_error");
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const field = (name: string) => (typeof form[name] === "string" ? form[name] : undefined);
    const result = await exchangeAssertion(
      deps.compat,
      { grantType: field("grant_type"), assertion: field("assertion") },
      { ...tokenConfig, now: Date.now() },
    );
    c.header("Cache-Control", "no-store");
    return result.ok ? c.json(result.value) : c.json(result.value, result.status);
  });

  app.use("*", gcsAuth(deps.compat, tokenConfig));

  app.get("/storage/v1/b/:bucket/o", async (c) => {
    const unsupported = unsupportedListing(c);
    if (unsupported) return compatErrorResponse("json", { code: "not_implemented", what: unsupported });
    const query = listQueryOf(c);
    if (!query) return gcsError("json", "invalid", "Invalid maxResults.");
    const result = await layerOf(c).list(c.req.param("bucket"), query);
    if (!result.ok) return compatErrorResponse("json", result.error);
    return c.json(listResource(result.value, apiOrigin));
  });

  app.get("/storage/v1/b/:bucket/o/:object", async (c) => {
    if (queryOf(c, "alt") === "media") return gcsError("json", "not_implemented");
    const bucket = c.req.param("bucket");
    const key = parseObjectKey(c.req.param("object"));
    if (!key) return gcsError("json", "invalid", "Invalid object name.");
    const result = await layerOf(c).head(bucket, key);
    if (!result.ok) return compatErrorResponse("json", result.error, `${bucket}/${key}`);
    return c.json(objectResource(result.value, apiOrigin));
  });

  app.delete("/storage/v1/b/:bucket/o/:object", async (c) => {
    const key = parseObjectKey(c.req.param("object"));
    if (!key) return gcsError("json", "invalid", "Invalid object name.");
    const result = await layerOf(c).delete(c.req.param("bucket"), key);
    if (!result.ok) return compatErrorResponse("json", result.error);
    return c.body(null, 204);
  });

  async function continueUpload(c: Context<GcsEnv>, id: string): Promise<Response> {
    const range = contentRangeOf(c.req.header("Content-Range"));
    if (!range) return gcsError("json", "invalid", "Invalid Content-Range.");
    const declared = declaredHashesOf(c.req.header("X-Goog-Hash"));
    if (!declared) return gcsError("json", "invalid", "Invalid X-Goog-Hash.");
    const uploads = uploadsOf(c);
    const bucket = c.req.param("bucket")!;
    const result = range === "query"
      ? await uploads.status(id, bucket)
      : await uploads.append(id, bucket, range, c.req.raw.body, declared);
    if (!result.ok) return compatErrorResponse("json", result.error);
    return uploadStatusResponse(c, result.value, apiOrigin);
  }

  app.delete("/upload/storage/v1/b/:bucket/o", async (c) => {
    const id = queryOf(c, "upload_id");
    if (queryOf(c, "uploadType") !== "resumable" || id === null) return gcsError("json", "not_implemented");
    const result = await uploadsOf(c).cancel(id, c.req.param("bucket"));
    if (!result.ok) return compatErrorResponse("json", result.error);
    return new Response(null, { status: CLIENT_CLOSED_REQUEST });
  });

  app.put("/upload/storage/v1/b/:bucket/o", async (c) => {
    const id = queryOf(c, "upload_id");
    if (queryOf(c, "uploadType") !== "resumable" || id === null) return gcsError("json", "not_implemented");
    return continueUpload(c, id);
  });

  app.post("/upload/storage/v1/b/:bucket/o", async (c) => {
    const uploadType = queryOf(c, "uploadType");
    const uploadId = queryOf(c, "upload_id");
    if (uploadType === "resumable" && uploadId !== null) return continueUpload(c, uploadId);
    if (uploadType !== "media" && uploadType !== "multipart" && uploadType !== "resumable") return gcsError("json", "not_implemented");
    if (UNSUPPORTED_PRECONDITIONS.some((name) => queryOf(c, name) !== null)) {
      return compatErrorResponse("json", { code: "not_implemented", what: "metageneration and not-match preconditions" });
    }
    const generationMatch = generationMatchOf(c);
    if (!generationMatch.ok) return gcsError("json", "invalid", "Invalid ifGenerationMatch.");
    if (uploadType === "resumable") {
      const begun = await beginUpload(c);
      if (begun instanceof Response) return begun;
      const key = parseObjectKey(begun.name ?? "");
      if (!key) return gcsError("json", "invalid", "Invalid object name.");
      const bucket = c.req.param("bucket");
      const result = await uploadsOf(c).begin(bucket, key, { ...begun.meta, ifGenerationMatch: generationMatch.value });
      if (!result.ok) return compatErrorResponse("json", result.error);
      const location = `${apiOrigin}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&upload_id=${result.value}`;
      return c.body(null, 200, { Location: location, "X-GUploader-UploadID": result.value });
    }
    const upload = uploadType === "media" ? mediaUpload(c) : await multipartUpload(c);
    if (upload instanceof Response) return upload;
    const key = parseObjectKey(upload.name ?? "");
    if (!key) return gcsError("json", "invalid", "Invalid object name.");
    const result = await layerOf(c).put(c.req.param("bucket"), key, { ...upload.meta, ifGenerationMatch: generationMatch.value }, upload.body);
    if (!result.ok) return compatErrorResponse("json", result.error);
    return c.json(objectResource(result.value, apiOrigin));
  });

  app.all("*", (c) => gcsError(surfaceOf(c.req.path), "not_implemented"));
  return app;
}

type Upload = { name: string | null; meta: Omit<PutMeta, "ifGenerationMatch">; body: SizedBody };

const RESUMABLE_METADATA_MAX_BYTES = 64 * 1024;

/** GCS answers a cancelled resumable upload with 499. */
const CLIENT_CLOSED_REQUEST = 499;

async function beginUpload(c: Context<GcsEnv>): Promise<Omit<Upload, "body"> | Response> {
  const raw = await readCapped(c.req.raw.body, RESUMABLE_METADATA_MAX_BYTES);
  if (!raw) return gcsError("json", "too_large");
  let resource: ObjectResource = {};
  try {
    if (raw.length > 0) resource = JSON.parse(new TextDecoder().decode(raw)) as ObjectResource;
  } catch {
    return gcsError("json", "invalid", "The object metadata is not JSON.");
  }
  const userMeta = resource && typeof resource === "object" ? stringRecord(resource.metadata) : null;
  if (!userMeta) return gcsError("json", "invalid", "Invalid object metadata.");
  return {
    name: queryOf(c, "name") ?? optionalString(resource.name),
    meta: {
      contentType: optionalString(resource.contentType) ?? c.req.header("X-Upload-Content-Type") ?? "application/octet-stream",
      contentEncoding: optionalString(resource.contentEncoding),
      userMeta,
    },
  };
}

export function contentRangeOf(header: string | undefined): Chunk | "query" | null {
  const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const total = match[3] === "*" ? null : Number(match[3]);
  if (total !== null && !Number.isSafeInteger(total)) return null;
  if (match[1] === undefined) return total === null ? "query" : { start: null, size: 0, total };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start || (total !== null && end >= total)) return null;
  return { start, size: end - start + 1, total };
}

export function declaredHashesOf(header: string | undefined): DeclaredHashes | null {
  const declared: DeclaredHashes = { crc32c: null, md5: null };
  for (const part of (header ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    const name = part.slice(0, eq).trim();
    if (name === "crc32c") {
      if (bytes.length !== 4) return null;
      declared.crc32c = new DataView(bytes.buffer).getUint32(0, false);
    } else if (name === "md5") {
      if (bytes.length !== 16) return null;
      declared.md5 = bytes;
    }
  }
  return declared;
}

/**
 * GCS signals "resume incomplete" with a 308. A client that sends
 * `X-GUploader-No-308: yes` (the Go client does) fails on a 308, and reads
 * the same answer from a 200 with `X-Http-Status-Code-Override: 308`.
 */
function uploadStatusResponse(c: Context<GcsEnv>, status: UploadStatus, apiOrigin: string): Response {
  if (status.kind === "committed") return c.json(objectResource(status.info, apiOrigin));
  const headers: Record<string, string> = {};
  if (status.received > 0) headers.Range = `bytes=0-${status.received - 1}`;
  if (c.req.header("X-GUploader-No-308") === "yes") {
    return c.body(null, 200, { ...headers, "X-Http-Status-Code-Override": "308" });
  }
  return c.body(null, 308, headers);
}

function mediaUpload(c: Context<GcsEnv>): Upload | Response {
  const length = c.req.header("Content-Length");
  if (length === undefined || !/^\d+$/.test(length)) return gcsError("json", "length_required");
  return {
    name: queryOf(c, "name"),
    meta: {
      contentType: c.req.header("Content-Type") ?? "application/octet-stream",
      contentEncoding: queryOf(c, "contentEncoding"),
      userMeta: {},
    },
    body: { stream: c.req.raw.body ?? streamOf(new Uint8Array(0)), size: Number(length) },
  };
}

async function multipartUpload(c: Context<GcsEnv>): Promise<Upload | Response> {
  const boundary = boundaryOf(c.req.header("Content-Type"));
  if (!boundary) return gcsError("json", "invalid", "uploadType=multipart needs a multipart/related body.");
  const raw = await readCapped(c.req.raw.body, MULTIPART_MAX_BYTES);
  if (!raw) return gcsError("json", "too_large");
  const parts = parseRelated(raw, boundary);
  if (!parts) return gcsError("json", "invalid", "Malformed multipart/related body.");
  let resource: ObjectResource;
  try {
    resource = JSON.parse(new TextDecoder().decode(parts.metadata)) as ObjectResource;
  } catch {
    return gcsError("json", "invalid", "The metadata part is not JSON.");
  }
  const userMeta = resource && typeof resource === "object" ? stringRecord(resource.metadata) : null;
  if (!userMeta) return gcsError("json", "invalid", "Invalid object metadata.");
  const hasher = createHasher();
  hasher.update(parts.media);
  const hashes = hasher.digest();
  const mismatch = declaredHashMismatch(resource, hashes);
  if (mismatch) return gcsError("json", "invalid", mismatch);
  return {
    name: queryOf(c, "name") ?? optionalString(resource.name),
    meta: {
      contentType: optionalString(resource.contentType) ?? parts.mediaType ?? "application/octet-stream",
      contentEncoding: optionalString(resource.contentEncoding),
      userMeta,
    },
    body: { stream: streamOf(parts.media), size: parts.media.length, hashes },
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function declaredHashMismatch(resource: ObjectResource, actual: ExactHashes): string | null {
  const crc32c = optionalString(resource.crc32c);
  const md5 = optionalString(resource.md5Hash);
  if (crc32c && crc32c !== crc32cBase64(actual.crc32c)) return "Provided CRC32C does not match the uploaded data.";
  if (md5 && md5 !== base64Of(actual.md5)) return "Provided MD5 hash does not match the uploaded data.";
  return null;
}
