/**
 * The password page and the responses around it (ADR-013 B7).
 *
 * Kept out of `core/file/handler.ts` so the delivery path stays about
 * delivery, and out of a template engine so a protected site costs no
 * dependency and no second request for CSS.
 *
 * **Why a page rather than the browser's own dialog.** `WWW-Authenticate:
 * Basic` makes a browser show a native credential prompt: unbranded,
 * unstyleable, with no way to sign out and no way to say "wrong password" in
 * the site's own words. Netlify, Vercel and Cloudflare Pages all serve a page
 * instead. So do we — but only for requests that look like a browser opening a
 * page, because `curl`, QGIS and Cesium want the header (see
 * {@link looksLikeBrowserNavigation}).
 */

/** The realm name sent with `WWW-Authenticate`. */
export const REALM = "reearth-serve";

export const WWW_AUTHENTICATE = `Basic realm="${REALM}", charset="UTF-8"`;

/**
 * The browser heuristic: does this request look like a person navigating?
 *
 * A navigation carries `Accept: text/html,…` (every browser sends it for a
 * top-level document); an API client, a tile fetch, a `curl` or an `<img>` does
 * not. When it looks like a navigation we answer with the HTML form and
 * deliberately omit `WWW-Authenticate`, so the browser renders our page instead
 * of stacking a native dialog on top of it. Everything else gets the header and
 * a JSON body, which is what makes `curl -u`, `file cp --password` and
 * Cesium's `Resource` work.
 *
 * It is a heuristic, and it fails in the harmless direction: a hand-rolled
 * client that sends `Accept: text/html` sees an HTML form it can ignore in
 * favour of sending Basic on the next request.
 */
export function looksLikeBrowserNavigation(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").toLowerCase().includes("text/html");
}

/** Headers every challenge and every auth-form response carries. */
export function noStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The password form.
 *
 * `action` is where the form posts (`/_serve/auth` on a site host,
 * `/files/{id}/_serve/auth` on the apex) and `next` is the path to return to,
 * carried as a hidden field because the POST is a new request that knows
 * nothing about where the visitor was.
 */
export function passwordPage(opts: { action: string; next: string; error?: string }): string {
  const error = opts.error
    ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Password required</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f7f9; color: #16191d;
  }
  main { width: min(22rem, calc(100vw - 2rem)); }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  p { margin: 0 0 1rem; color: #5b6470; }
  form { display: grid; gap: .6rem; }
  input, button {
    font: inherit; padding: .6rem .7rem; border-radius: .4rem;
    border: 1px solid #c7ccd3; background: #fff; color: inherit;
  }
  button { border: 0; background: #1b6ef3; color: #fff; cursor: pointer; }
  .error { color: #c0392b; }
  @media (prefers-color-scheme: dark) {
    body { background: #14171a; color: #e8eaed; }
    p { color: #9aa4b0; }
    input { background: #1e2226; border-color: #3a4047; }
  }
</style>
<main>
  <h1>Password required</h1>
  <p>This site is protected. Enter the password to continue.</p>
  ${error}
  <form method="post" action="${escapeHtml(opts.action)}">
    <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
    <input type="password" name="password" autocomplete="current-password"
           aria-label="Password" autofocus required>
    <button type="submit">Continue</button>
  </form>
</main>
</html>`;
}

/** `401` with the form; no `WWW-Authenticate`, so no native dialog. */
export function passwordPageResponse(
  opts: { action: string; next: string; error?: string },
): Response {
  return new Response(passwordPage(opts), {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...noStoreHeaders(),
    },
  });
}

/** `401` for everything that is not a browser navigation. */
export function basicChallengeResponse(): Response {
  return new Response(JSON.stringify({ error: "authentication required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": WWW_AUTHENTICATE,
      ...noStoreHeaders(),
    },
  });
}

/** `429` once the failure budget for this window is spent. */
export function rateLimitedResponse(retryAfterSeconds: number, html: boolean): Response {
  const body = html
    ? '<!doctype html><meta charset="utf-8"><title>Too many attempts</title>' +
      "<h1>Too many attempts</h1><p>Wait a few minutes and try again.</p>"
    : JSON.stringify({ error: "too many failed attempts" });
  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": html ? "text/html; charset=utf-8" : "application/json",
      "Retry-After": String(retryAfterSeconds),
      ...noStoreHeaders(),
    },
  });
}

/**
 * `503` when the asset is protected but the deployment has no
 * `SIGNING_SECRET`.
 *
 * Fail closed, exactly as `/api/internal/*` does without
 * `INTERNAL_API_SECRET`: without the secret no cookie can be minted or
 * trusted, and serving the bytes anyway would silently unprotect every
 * protected asset the moment a secret went missing from an environment.
 */
export function signingSecretMissingResponse(): Response {
  return new Response(JSON.stringify({ error: "SIGNING_SECRET not configured" }), {
    status: 503,
    headers: { "Content-Type": "application/json", ...noStoreHeaders() },
  });
}
