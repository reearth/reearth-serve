import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { canAccessProject, type AccessContext } from "../access";

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
