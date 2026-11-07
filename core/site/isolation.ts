/**
 * The startup check that site hosts are really isolated from the API
 * (ADR-013 B1).
 *
 * Browsers treat every host under one registrable domain as the same site:
 * `SameSite` cookies flow between them and a sibling can set cookies for the
 * parent. So `{id}.sites.example.net` is isolated from `api.example.com`, but
 * not from `api.example.net`, and cookie scope alone cannot fix that. When site
 * hosts are on, Serve refuses to start unless the suffix lies under
 * `SITE_REGISTRABLE_DOMAIN` and `BASE_URL` does not.
 *
 * `SITE_DOMAIN_IS_PUBLIC_SUFFIX=true` skips the check, for a domain on the
 * Public Suffix List, where every child already is its own site. Loopback is
 * the local case: browsers apply the list's default rule to an unlisted TLD
 * such as `localhost`.
 */

export type IsolationEnv = Partial<Record<
  "SITE_HOST_SUFFIX" | "BASE_URL" | "SITE_REGISTRABLE_DOMAIN" | "SITE_DOMAIN_IS_PUBLIC_SUFFIX",
  string | undefined
>>;

/** Lowercase, without port or trailing dot. */
function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function isUnder(host: string, domain: string): boolean {
  return host.endsWith(`.${domain}`);
}

/** Throws when the configuration would serve sites on the API's own site. */
export function checkSiteIsolation(env: IsolationEnv): { publicSuffixOverride: boolean } {
  if (!env.SITE_HOST_SUFFIX) return { publicSuffixOverride: false };
  if (!env.BASE_URL) throw new Error("SITE_HOST_SUFFIX is set, so BASE_URL is required");
  if (!env.SITE_REGISTRABLE_DOMAIN) {
    throw new Error("SITE_HOST_SUFFIX is set, so SITE_REGISTRABLE_DOMAIN is required");
  }
  if (env.SITE_DOMAIN_IS_PUBLIC_SUFFIX === "true") return { publicSuffixOverride: true };

  const domain = bareHost(env.SITE_REGISTRABLE_DOMAIN);
  const suffixHost = bareHost(env.SITE_HOST_SUFFIX.trim().replace(/^\./, ""));
  if (!isUnder(suffixHost, domain)) {
    throw new Error(
      `SITE_HOST_SUFFIX "${env.SITE_HOST_SUFFIX}" must be a host under SITE_REGISTRABLE_DOMAIN "${domain}"`,
    );
  }
  const baseHost = bareHost(new URL(env.BASE_URL).hostname);
  if (baseHost === domain || isUnder(baseHost, domain)) {
    throw new Error(
      `BASE_URL host "${baseHost}" is on the same site as the site hosts (${domain}); ` +
      "put the API on another registrable domain, or set SITE_DOMAIN_IS_PUBLIC_SUFFIX=true if it is on the Public Suffix List",
    );
  }
  return { publicSuffixOverride: false };
}

/** The line both runtimes log when the override is in force. */
export const PUBLIC_SUFFIX_OVERRIDE_NOTICE =
  "SITE_DOMAIN_IS_PUBLIC_SUFFIX=true: the site-isolation check is skipped; SITE_REGISTRABLE_DOMAIN must be on the Public Suffix List";
