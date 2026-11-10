import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { accessCtx, authorizeProject } from "../../auth/access";
import { usageScopesFor } from "../usecase/shared";
import { blobScopeFor, type BlobContext } from "../../blob/usecase";
import { CONTENT_SHA256_HEADER, parseSha256Header } from "../integrity";
import { isSafeFilename } from "../../../shared/api";

/**
 * Block uploads from unauthenticated callers when anonymous uploads are
 * disabled by the operator. Returns a 401 response or null when the caller
 * is allowed to proceed.
 *
 * Read paths and metadata operations are not gated — only mutation routes
 * that create or modify assets should call this.
 */
export function denyAnonymousUpload(c: Context<AppEnv>): Response | null {
  if (c.get("user")) return null;
  if (c.get("anonymousUploadEnabled")) return null;
  return c.json(
    {
      error:
        "Anonymous upload is disabled on this server. Please log in with `reearth-serve auth login` and try again.",
    },
    401,
  );
}


/**
 * Resolve the project binding for an upload-like action. Documented by
 * `projectIdHeaderParam` (core/openapi.ts).
 * - Anon caller (`!user`): returns `{ projectId: null }` — falls back to session scope.
 * - Authenticated caller: requires the `X-Project-Id` header AND workspace
 *   membership. Missing header → 400; unknown/unauthorized project → 404.
 */
export async function resolveUploadProject(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; projectId: string | null }
  | { ok: false; status: 400 | 404; error: string }
> {
  const user = c.get("user");
  const header = c.req.header("X-Project-Id")?.trim();
  if (!user) {
    return { ok: true, projectId: null };
  }
  if (!header) {
    return {
      ok: false,
      status: 400,
      error: "Authenticated uploads require the X-Project-Id header",
    };
  }
  const access = await authorizeProject(accessCtx(c), header, "create_asset");
  if (!access.ok) {
    return { ok: false, status: 404, error: "Project not found" };
  }
  return { ok: true, projectId: header };
}

/**
 * Storage-usage counter scopes for a project asset: the project itself and,
 * when the project belongs to one, its workspace. Empty for session-scoped
 * (demo) assets, which are not counted.
 *
 * Resolved before the write so the counters can travel in the same atomic
 * batch as the asset/version row (ADR-012 §3) instead of being incremented
 * afterwards, where a failure left the counters short.
 */
export async function usageScopes(
  c: Context<AppEnv>,
  projectId: string | null | undefined,
): Promise<string[]> {
  return usageScopesFor(c.get("projects"), projectId);
}

/**
 * The blob ledger and scope an upload into `projectId` is placed with
 * (ADR-017 §3); for a demo upload (no project), the scope of `sessionId`, the
 * anonymous session that owns the asset. Resolved only when the upload
 * declared a hash: an undeclared one never touches the blob layer, so it pays
 * no project lookup for it. Undefined, too, when there is no scope (a demo
 * upload without a session ID); the upload is then stored at its classic key.
 */
export async function blobContext(
  c: Context<AppEnv>,
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  sha256: string | undefined,
): Promise<BlobContext | undefined> {
  if (!sha256) return undefined;
  const scope = await blobScopeFor(c.get("projects"), projectId, sessionId);
  return scope ? { refs: c.get("blobRefs"), scope } : undefined;
}

/**
 * The headers and body of a direct upload (`POST /api/v1/assets` and
 * `POST /api/v1/assets/{id}`), checked before a byte is read.
 *
 * `Content-Length` must be positive — except with `X-Content-SHA256`, where 0
 * (or no body at all) is an upload of an empty file. The use case checks the
 * empty body against the declaration like any other body: it is stored only
 * when the declaration is the SHA-256 of zero bytes, and answers 422
 * otherwise, whatever the workspace holds (ADR-017 §4).
 */
export function parseDirectUploadHeaders(c: Context<AppEnv>):
  | { ok: true; filename: string; size: number; sha256: string | undefined; body: ReadableStream<Uint8Array> }
  | { ok: false; error: string } {
  const filename = c.req.header("X-Filename");
  const sha256 = parseSha256Header(c.req.header(CONTENT_SHA256_HEADER));
  const rawBody = c.req.raw.body;
  // A client sending no body at all may omit Content-Length; with a declared
  // hash that is the same request as `Content-Length: 0`.
  const contentLength = c.req.header("Content-Length") ?? (sha256 && sha256 !== "invalid" && !rawBody ? "0" : undefined);
  if (!filename || !contentLength) {
    return { ok: false, error: "Missing required headers: X-Filename, Content-Length" };
  }
  if (!isSafeFilename(filename)) return { ok: false, error: "Invalid X-Filename" };

  const size = parseInt(contentLength, 10);
  if (isNaN(size) || size < 0 || (size === 0 && !sha256)) {
    return { ok: false, error: "Invalid Content-Length" };
  }
  if (sha256 === "invalid") {
    return { ok: false, error: `Invalid ${CONTENT_SHA256_HEADER}: expected 64 hex characters` };
  }
  const body = rawBody ?? (size === 0 ? emptyBody() : null);
  if (!body) return { ok: false, error: "Missing request body" };
  return { ok: true, filename, size, sha256, body };
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
}
