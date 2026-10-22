/**
 * `POST …/_serve/auth` — the password form's endpoint (ADR-013 B7).
 *
 * On a site host the visitor posts to `/_serve/auth`; the site middleware
 * rewrites it into `/files/{id}/_serve/auth`, which is also the apex form's
 * own URL, so one route serves both. The route is registered ahead of the
 * catch-all file route and only for `POST`, which is what keeps an archive
 * containing a real file called `_serve/auth` from shadowing it: that file is
 * still served on `GET`, and no `POST` ever reaches file lookup.
 *
 * On success the response sets the cookie and `303`s back to where the visitor
 * was. `303`, not `302`: the method must become `GET`, or the browser would
 * re-POST the password to the page it lands on.
 */

import type { AssetMetadata } from "../asset/model";
import {
  buildSetCookie,
  COOKIE_MAX_AGE_SECONDS,
  mintAuthCookie,
  shouldUseSecureCookie,
} from "./cookie";
import {
  noStoreHeaders,
  passwordPageResponse,
  rateLimitedResponse,
  signingSecretMissingResponse,
} from "./page";
import { verifyPassword } from "./password";
import { checkRateLimit, clearFailures, clientIp, recordFailure } from "./ratelimit";
import {
  accessModeOf,
  authActionPath,
  safeNextPath,
  type AccessDeps,
} from "./resolve";

/**
 * Handle one form submission.
 *
 * Returns `null` when the asset is not protected at all — there is no password
 * endpoint on a public asset, and the caller turns that into the ordinary
 * `404` rather than confirming that the ID exists and is unprotected.
 */
export async function handleAuthSubmit(
  asset: AssetMetadata,
  request: Request,
  deps: AccessDeps,
): Promise<Response | null> {
  if (accessModeOf(asset) !== "password") return null;

  const secret = deps.signingSecret;
  if (!secret) return signingSecretMissingResponse();

  const protection = await deps.metadata.findProtection(asset.id);
  if (!protection) return signingSecretMissingResponse();

  const form = await readForm(request);
  const action = authActionPath(asset.id, deps.siteHost);
  const fallback = deps.siteHost ? "/" : `/files/${asset.id}/`;
  const next = safeNextPath(form.next, fallback);

  const now = deps.now ?? Date.now();
  const ip = clientIp(request);

  const limit = await checkRateLimit(deps.kv, asset.id, ip, now);
  if (limit.limited) return rateLimitedResponse(limit.retryAfterSeconds, true);

  if (typeof form.password !== "string" || !(await verifyPassword(form.password, protection))) {
    await recordFailure(deps.kv, asset.id, ip, now);
    return passwordPageResponse({ action, next, error: "Wrong password. Try again." });
  }

  await clearFailures(deps.kv, asset.id, ip);

  const value = await mintAuthCookie(secret, {
    assetId: asset.id,
    passwordVersion: protection.version,
    exp: Math.floor(now / 1000) + COOKIE_MAX_AGE_SECONDS,
  });

  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": buildSetCookie({
        value,
        // On a site host the whole origin is this asset, so `/` is exact. On the
        // apex the cookie is scoped to the asset's own file prefix — a weaker
        // boundary than an origin, and one more reason site hosts (B1) come
        // first.
        path: deps.siteHost ? "/" : `/files/${asset.id}`,
        secure: shouldUseSecureCookie(new URL(request.url)),
      }),
      ...noStoreHeaders(),
    },
  });
}

/**
 * Read `password` and `next` out of the submitted form.
 *
 * A body that is not a form at all (a probe, a crawler) yields neither field
 * and lands on the wrong-password path, which is the right answer: it is an
 * attempt, and it should be counted as one.
 */
async function readForm(request: Request): Promise<{ password?: string; next?: string }> {
  try {
    const data = await request.formData();
    const password = data.get("password");
    const next = data.get("next");
    return {
      password: typeof password === "string" ? password : undefined,
      next: typeof next === "string" ? next : undefined,
    };
  } catch {
    return {};
  }
}
