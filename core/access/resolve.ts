/**
 * `resolveAccess` — the one request-time access check on file delivery
 * (ADR-013 B7, ADR-014 §5).
 *
 * Until now `/files/…` was pure capability: knowing the asset ID granted the
 * bytes, and the handler carried a note saying not to add access checks. That
 * note becomes: **capability by default, access mode when the asset asks for
 * it.** `public` — every asset unless someone says otherwise — takes the same
 * path it always did and pays nothing: no second store read, no crypto, no
 * branch beyond one string comparison on a row the handler had already loaded.
 *
 * The check sits in front of *every* form of file URL, because it is called
 * from the one handler they all end in: `/files/{id}/…`, `{id}.serve…`,
 * `{versionId}.serve…`, `{name}.serve…`, `v{n}--name`, `latest--name`, custom
 * domains, thumbnails, ranges and `HEAD`. Protecting a named host while
 * `/files/{id}/` stayed open would be theatre — the ID is printed in every
 * `siteUrl` we hand out.
 *
 * ADR-014 adds `restricted` as a third mode with more proofs (signed URLs, API
 * keys, OIDC bearers, grants). It slots into the same switch and returns the
 * same union; nothing in the delivery path has to change again.
 */

import type { AssetMetadata } from "../asset/model";
import type { MetadataStore } from "../asset/repository";
import type { KeyValue } from "../kv/port";
import { AUTH_COOKIE, parseCookieHeader, verifyAuthCookie } from "./cookie";
import {
  basicChallengeResponse,
  looksLikeBrowserNavigation,
  noStoreHeaders,
  passwordPageResponse,
  rateLimitedResponse,
  signingSecretMissingResponse,
} from "./page";
import { basicPassword, verifyPassword } from "./password";
import { checkRateLimit, clearFailures, clientIp, recordFailure } from "./ratelimit";

/**
 * The asset's access mode.
 *
 * ADR-013 B7 calls the field `hosting.access`; ADR-014 §1 makes the flat
 * `access` canonical and says the two are the same field. The flat name is what
 * is implemented: nesting it under `hosting` would have to be undone when
 * ADR-014's `restricted` mode lands, which applies to assets that are not
 * sites at all.
 *
 * Setting `password` is limited to archive (site) assets for now — see
 * `core/asset/usecase/set-access.ts`. That is a restriction on the *write*
 * path only; everything below is written against the mode, so lifting it is a
 * one-line change.
 */
export type AccessMode = "public" | "password";

/** The mode of an asset, defaulting to `public` for every row that has none. */
export function accessModeOf(asset: Pick<AssetMetadata, "access">): AccessMode {
  return asset.access === "password" ? "password" : "public";
}

/** The path segment the auth form posts to, under the asset's file prefix. */
export const AUTH_PATH_SEGMENT = "_serve/auth";

export interface AccessDeps {
  metadata: MetadataStore;
  /** Where the failed-attempt counters live (ADR-012 §2). */
  kv: KeyValue;
  /** `SIGNING_SECRET`. Undefined ⇒ protected assets fail closed. */
  signingSecret: string | undefined;
  /**
   * True when the request arrived on a site host and was rewritten into
   * `/files/{id}/…` (ADR-013 B1).
   *
   * It comes from the context variable the composition root sets when it builds
   * the file-only router, never from a request header — the same discipline the
   * site middleware applies to `x-reearth-site-preview`, which it deletes off
   * every incoming request before setting it. A visitor therefore cannot claim
   * to be on a site host and move the cookie's `Path` to `/`.
   */
  siteHost: boolean;
  /** Injectable clock, for tests. */
  now?: number;
}

export type AccessResolution =
  | { kind: "allow"; protected: boolean; principal?: string }
  | { kind: "challenge"; response: Response };

const ALLOW_PUBLIC: AccessResolution = { kind: "allow", protected: false };

/**
 * Decide whether this request may read this asset's bytes.
 *
 * Called before any storage I/O, so a refused request costs one metadata read
 * (already spent resolving the asset) and never touches the object store.
 */
export async function resolveAccess(
  asset: AssetMetadata,
  request: Request,
  deps: AccessDeps,
): Promise<AccessResolution> {
  if (accessModeOf(asset) !== "password") return ALLOW_PUBLIC;

  const secret = deps.signingSecret;
  if (!secret) return { kind: "challenge", response: signingSecretMissingResponse() };

  const protection = await deps.metadata.findProtection(asset.id);
  if (!protection) {
    // The row says `password` but carries no hash: nothing could ever verify,
    // so serving the bytes would silently unprotect the asset.
    return { kind: "challenge", response: misconfiguredResponse() };
  }

  const now = deps.now ?? Date.now();

  // 1. The cookie. Pure computation — no store read, no PBKDF2 — which is why
  //    it is what a browsing visitor carries after one form submit.
  const cookies = parseCookieHeader(request.headers.get("Cookie"));
  const cookieOk = await verifyAuthCookie(secret, cookies[AUTH_COOKIE], {
    assetId: asset.id,
    passwordVersion: protection.version,
    now,
  });
  if (cookieOk) return { kind: "allow", protected: true, principal: "password" };

  // 2. `Authorization: Basic`. One PBKDF2 per request that uses it, which is
  //    the price of a stateless tool (curl, QGIS, `file cp`) that keeps no
  //    cookie jar.
  const submitted = basicPassword(request.headers.get("Authorization"));
  if (submitted !== null) {
    const ip = clientIp(request);
    const limit = await checkRateLimit(deps.kv, asset.id, ip, now);
    if (limit.limited) {
      return { kind: "challenge", response: rateLimitedResponse(limit.retryAfterSeconds, false) };
    }
    if (await verifyPassword(submitted, protection)) {
      await clearFailures(deps.kv, asset.id, ip);
      return { kind: "allow", protected: true, principal: "password" };
    }
    await recordFailure(deps.kv, asset.id, ip, now);
  }

  // 3. Nothing valid: a page for a browser, the Basic challenge for everyone
  //    else. `401`, not `404` — protection hides the bytes, not the existence.
  return { kind: "challenge", response: challengeFor(request, asset.id, deps.siteHost) };
}

/** The `401` a request with no usable proof gets. */
export function challengeFor(request: Request, assetId: string, siteHost: boolean): Response {
  if (!looksLikeBrowserNavigation(request)) return basicChallengeResponse();
  return passwordPageResponse({
    action: authActionPath(assetId, siteHost),
    next: visitorPath(request, assetId, siteHost),
  });
}

function misconfiguredResponse(): Response {
  return new Response(JSON.stringify({ error: "asset protection is misconfigured" }), {
    status: 503,
    headers: { "Content-Type": "application/json", ...noStoreHeaders() },
  });
}

/**
 * Where the password form posts.
 *
 * On a site host the visitor's URL space is the asset's, so the endpoint is
 * `/_serve/auth`; the site middleware rewrites it to `/files/{id}/_serve/auth`
 * on the way in, which is the same route the apex form uses directly.
 */
export function authActionPath(assetId: string, siteHost: boolean): string {
  return siteHost ? `/${AUTH_PATH_SEGMENT}` : `/files/${assetId}/${AUTH_PATH_SEGMENT}`;
}

/**
 * The path as the *visitor's* browser sees it.
 *
 * On a site host that is the request path with the middleware's
 * `/files/{id}` rewrite taken back off, so the hidden `next` field — and the
 * `303` that follows it — point at `/docs/` rather than at
 * `{name}.serve…/files/{id}/docs/`.
 */
export function visitorPath(request: Request, assetId: string, siteHost: boolean): string {
  const url = new URL(request.url);
  const path = siteHost ? stripFilePrefix(url.pathname, assetId) : url.pathname;
  return `${path}${url.search}`;
}

function stripFilePrefix(pathname: string, assetId: string): string {
  const prefix = `/files/${assetId}`;
  if (!pathname.startsWith(prefix)) return pathname;
  return pathname.slice(prefix.length) || "/";
}

/**
 * `next`, but only when it is a path on this same origin.
 *
 * An open redirect on a login form is the classic phishing primitive: a link to
 * the real, trusted site that hands the visitor to an attacker's copy the
 * moment they type the password. Only a rooted path survives — an absolute URL
 * (`https://evil.example`), a scheme-relative one (`//evil.example`) and the
 * backslash forms browsers normalise into it are all replaced by the fallback.
 */
export function safeNextPath(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value === "") return fallback;
  const normalized = value.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return fallback;
  if (normalized.startsWith("//")) return fallback;
  return normalized;
}
