import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "../types";
import type { AuthUser } from "./types";

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedIssuer: string | null = null;

function getJWKS(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  // Cache JWKS within the same isolate
  if (cachedJWKS && cachedIssuer === issuer) return cachedJWKS;

  const jwksUrl = new URL(".well-known/jwks.json", issuer.endsWith("/") ? issuer : `${issuer}/`);
  cachedJWKS = createRemoteJWKSet(jwksUrl);
  cachedIssuer = issuer;
  return cachedJWKS;
}

/**
 * JWT authentication middleware.
 *
 * - If OIDC_ISSUER_URL is not configured, all requests proceed as demo mode (user = null).
 * - If Authorization header is present, validates the JWT. Invalid tokens → 401.
 * - If no Authorization header, proceeds as demo mode (user = null).
 */
export function authMiddleware(env: { OIDC_ISSUER_URL?: string; OIDC_AUDIENCE?: string }) {
  const issuer = env.OIDC_ISSUER_URL;
  const audience = env.OIDC_AUDIENCE;

  return createMiddleware<AppEnv>(async (c, next) => {
    // No OIDC configured — everything is demo mode
    if (!issuer) {
      c.set("user", null);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      c.set("user", null);
      return next();
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ error: "Invalid Authorization header format. Expected: Bearer <token>" }, 401);
    }

    const token = match[1];

    try {
      const jwks = getJWKS(issuer);
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        ...(audience && { audience }),
      });

      const user: AuthUser = {
        sub: payload.sub!,
        email: payload.email as string | undefined,
        name: payload.name as string | undefined,
      };

      c.set("user", user);
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    return next();
  });
}
