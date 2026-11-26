import { JSON_API_PATH_PREFIXES, type CompatError, type ExactHashes, type ObjectInfo } from "../model";
import type { ListPage } from "../layer";
import { base64Of, crc32cBase64 } from "../hash";

export type GcsErrorCode =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "signature_mismatch"
  | "expired_token"
  | "bucket_not_found"
  | "object_not_found"
  | "length_required"
  | "invalid_digest"
  | "bad_digest"
  | "below_length_range"
  | "above_length_range"
  | "precondition_failed"
  | "too_large"
  | "not_implemented"
  | "busy"
  | "backend_error";

type ErrorSpec = {
  status: 400 | 401 | 403 | 404 | 411 | 412 | 413 | 500 | 501 | 503; reason: string; xmlCode: string; message: string;
};

const ERRORS: Record<GcsErrorCode, ErrorSpec> = {
  invalid: { status: 400, reason: "invalid", xmlCode: "InvalidArgument", message: "Invalid argument." },
  unauthenticated: { status: 401, reason: "authError", xmlCode: "AuthenticationRequired", message: "Invalid Credentials" },
  forbidden: { status: 403, reason: "forbidden", xmlCode: "AccessDenied", message: "Access denied." },
  signature_mismatch: {
    status: 403, reason: "forbidden", xmlCode: "SignatureDoesNotMatch",
    message: "The request signature we calculated does not match the signature you provided.",
  },
  expired_token: { status: 400, reason: "invalid", xmlCode: "ExpiredToken", message: "The provided token has expired." },
  bucket_not_found: { status: 404, reason: "notFound", xmlCode: "NoSuchBucket", message: "The specified bucket does not exist." },
  object_not_found: { status: 404, reason: "notFound", xmlCode: "NoSuchKey", message: "The specified key does not exist." },
  length_required: { status: 411, reason: "required", xmlCode: "MissingContentLength", message: "Content-Length is required." },
  invalid_digest: { status: 400, reason: "invalid", xmlCode: "InvalidDigest", message: "The Content-MD5 you specified is not valid." },
  bad_digest: { status: 400, reason: "invalid", xmlCode: "BadDigest", message: "The Content-MD5 you specified did not match what we received." },
  below_length_range: { status: 400, reason: "invalid", xmlCode: "EntityTooSmall", message: "The body is shorter than x-goog-content-length-range allows." },
  above_length_range: { status: 400, reason: "invalid", xmlCode: "EntityTooLarge", message: "The body is longer than x-goog-content-length-range allows." },
  precondition_failed: { status: 412, reason: "conditionNotMet", xmlCode: "PreconditionFailed", message: "At least one of the pre-conditions you specified did not hold." },
  too_large: { status: 413, reason: "uploadTooLarge", xmlCode: "EntityTooLarge", message: "The request body is too large for this upload type." },
  not_implemented: { status: 501, reason: "notImplemented", xmlCode: "NotImplemented", message: "This operation is not implemented by this server." },
  backend_error: { status: 500, reason: "backendError", xmlCode: "InternalError", message: "We encountered an internal error. Please try again." },
  busy: { status: 503, reason: "backendError", xmlCode: "SlowDown", message: "Another write to this object is in progress. Please try again." },
};

export type GcsSurface = "json" | "xml";

const JSON_API_PATH = new RegExp(
  `^/(${JSON_API_PATH_PREFIXES.map((prefix) => (prefix === "storage" ? prefix : `${prefix}/storage`)).join("|")})/v1(/|$)`,
);

export function surfaceOf(path: string): GcsSurface {
  return JSON_API_PATH.test(path) ? "json" : "xml";
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function gcsError(surface: GcsSurface, code: GcsErrorCode, message?: string): Response {
  const spec = ERRORS[code];
  const text = message ?? spec.message;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (spec.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="storage"';
  if (spec.status === 503) headers["Retry-After"] = "1";
  if (surface === "json") {
    const body = { error: { code: spec.status, message: text, errors: [{ message: text, domain: "global", reason: spec.reason }] } };
    return Response.json(body, { status: spec.status, headers });
  }
  const xml = `<?xml version='1.0' encoding='UTF-8'?><Error><Code>${spec.xmlCode}</Code><Message>${escapeXml(text)}</Message></Error>`;
  return new Response(xml, { status: spec.status, headers: { ...headers, "Content-Type": "application/xml; charset=UTF-8" } });
}

export function compatErrorResponse(surface: GcsSurface, error: CompatError, objectName?: string): Response {
  switch (error.code) {
    case "no_such_bucket": return gcsError(surface, "bucket_not_found");
    case "no_such_key": return gcsError(surface, "object_not_found", objectName ? `No such object: ${objectName}` : undefined);
    case "no_such_upload": return gcsError(surface, "object_not_found", "No such upload session.");
    case "forbidden": return gcsError(surface, "forbidden");
    case "precondition_failed": return gcsError(surface, "precondition_failed");
    case "busy": return gcsError(surface, "busy");
    case "invalid": return gcsError(surface, "invalid", error.message);
    case "too_large": return gcsError(surface, "too_large");
    case "not_implemented": return gcsError(surface, "not_implemented", `Not implemented: ${error.what}.`);
  }
}

/** int64 fields are decimal strings, as GCS sends them. */
export function objectResource(info: ObjectInfo, apiOrigin: string) {
  const name = encodeURIComponent(info.key);
  return {
    kind: "storage#object",
    id: `${info.bucket}/${info.key}/${info.generation}`,
    selfLink: `${apiOrigin}/storage/v1/b/${info.bucket}/o/${name}`,
    mediaLink: `${apiOrigin}/download/storage/v1/b/${info.bucket}/o/${name}?generation=${info.generation}&alt=media`,
    name: info.key,
    bucket: info.bucket,
    generation: String(info.generation),
    metageneration: String(info.metageneration),
    contentType: info.contentType,
    ...(info.contentEncoding && { contentEncoding: info.contentEncoding }),
    storageClass: "STANDARD",
    size: String(info.size),
    ...(info.hashes && { md5Hash: base64Of(info.hashes.md5), crc32c: crc32cBase64(info.hashes.crc32c) }),
    etag: info.etag,
    timeCreated: info.created.toISOString(),
    updated: info.updated.toISOString(),
    ...(Object.keys(info.userMeta).length > 0 && { metadata: info.userMeta }),
  };
}

function storedHeaders(info: ObjectInfo): Record<string, string> {
  return {
    "x-goog-generation": String(info.generation),
    "x-goog-metageneration": String(info.metageneration),
    "x-goog-stored-content-length": String(info.size),
    "x-goog-stored-content-encoding": info.contentEncoding ?? "identity",
  };
}

const hashHeader = (hashes: ExactHashes) => `crc32c=${crc32cBase64(hashes.crc32c)},md5=${base64Of(hashes.md5)}`;

/** The `ETag` header of an object on every surface; the JSON resource's `etag` is its value unquoted. */
export const etagHeader = (info: ObjectInfo) => `"${info.etag}"`;

/** The headers a GCS XML API write answers with. */
export function xmlObjectHeaders(info: ObjectInfo): Record<string, string> {
  return { ETag: etagHeader(info), ...storedHeaders(info), ...(info.hashes && { "x-goog-hash": hashHeader(info.hashes) }) };
}

export type SentRead = { status: number; sentEncoding: string | null; storedEncoding: string | null; hashes: ExactHashes | null };

/**
 * A client checks `x-goog-hash` against the bytes it received (ADR-019 §3), so
 * it goes only on a whole object sent in its stored encoding.
 */
export function readHashHeader(read: SentRead): string | null {
  const encoding = (value: string | null) => (value === null || value === "identity" ? null : value);
  if (read.status !== 200 || !read.hashes) return null;
  return encoding(read.sentEncoding) === encoding(read.storedEncoding) ? hashHeader(read.hashes) : null;
}

export function withReadHeaders(res: Response, info: ObjectInfo): Response {
  for (const [name, value] of Object.entries(storedHeaders(info))) res.headers.set(name, value);
  const hash = readHashHeader({
    status: res.status, sentEncoding: res.headers.get("Content-Encoding"), storedEncoding: info.contentEncoding, hashes: info.hashes,
  });
  if (hash) res.headers.set("x-goog-hash", hash);
  return res;
}

export function listResource(page: ListPage, apiOrigin: string) {
  return {
    kind: "storage#objects",
    ...(page.nextPageToken && { nextPageToken: page.nextPageToken }),
    ...(page.prefixes.length > 0 && { prefixes: page.prefixes }),
    items: page.objects.map((info) => objectResource(info, apiOrigin)),
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test.each([
    ["/storage/v1/b/media/o/k", "json"],
    ["/upload/storage/v1/b/media/o", "json"],
    ["/batch/storage/v1", "json"],
    ["/download/storage/v1/b/media/o/k", "json"],
    ["/media/assets/a.txt", "xml"],
    ["/storage", "xml"],
    ["/storage/v10/b", "xml"],
  ])("%s is the %s API", (path, surface) => {
    expect(surfaceOf(path)).toBe(surface);
  });

  test("the JSON shape is what googleapi.Error parses", async () => {
    const res = gcsError("json", "not_implemented");
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: {
        code: 501,
        message: "This operation is not implemented by this server.",
        errors: [{ message: "This operation is not implemented by this server.", domain: "global", reason: "notImplemented" }],
      },
    });
  });

  test("the XML shape names the S3-style code and escapes the message", async () => {
    const res = gcsError("xml", "object_not_found", "No <such> key");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=UTF-8");
    expect(await res.text()).toBe("<?xml version='1.0' encoding='UTF-8'?><Error><Code>NoSuchKey</Code><Message>No &#60;such&#62; key</Message></Error>");
  });

  const hashes: ExactHashes = { md5: new Uint8Array(16), crc32c: 0 };
  test.each([
    ["a whole identity read", { status: 200, sentEncoding: null, storedEncoding: null, hashes }, true],
    ["a whole gzip passthrough", { status: 200, sentEncoding: "gzip", storedEncoding: "gzip", hashes }, true],
    ["an identity read labelled identity", { status: 200, sentEncoding: "identity", storedEncoding: null, hashes }, true],
    ["a range", { status: 206, sentEncoding: null, storedEncoding: null, hashes }, false],
    ["a revalidation", { status: 304, sentEncoding: null, storedEncoding: null, hashes }, false],
    ["a gzip object decompressed for the client", { status: 200, sentEncoding: null, storedEncoding: "gzip", hashes }, false],
    ["an object with no stored hashes", { status: 200, sentEncoding: null, storedEncoding: null, hashes: null }, false],
  ] as const)("%s sends x-goog-hash: %s", (_, read, sent) => {
    expect(readHashHeader(read) !== null).toBe(sent);
  });

  test("a 401 carries a Bearer challenge", () => {
    expect(gcsError("json", "unauthenticated").headers.get("WWW-Authenticate")).toBe('Bearer realm="storage"');
  });
}
