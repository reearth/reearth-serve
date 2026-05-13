import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { canAccessProject, type AccessContext } from "../access";

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

export function accessCtx(c: Context<AppEnv>): AccessContext {
  return {
    sessionId: c.get("sessionId"),
    user: c.get("user"),
    authorizer: c.get("authorizer"),
    members: c.get("members"),
    projects: c.get("projects"),
  };
}

/**
 * Resolve the project binding for an upload-like action.
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
  const allowed = await canAccessProject(accessCtx(c), header, "upload");
  if (!allowed) {
    return { ok: false, status: 404, error: "Project not found" };
  }
  return { ok: true, projectId: header };
}
