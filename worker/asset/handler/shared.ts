import type { Context } from "hono";
import type { AppEnv } from "../../types";
import type { AccessContext } from "../access";

export function accessCtx(c: Context<AppEnv>): AccessContext {
  return {
    sessionId: c.get("sessionId"),
    user: c.get("user"),
    authorizer: c.get("authorizer"),
    members: c.get("members"),
    projects: c.get("projects"),
  };
}
