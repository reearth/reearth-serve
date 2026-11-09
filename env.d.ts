interface Env {
  STORAGE: R2Bucket;
  KV: KVNamespace;
  DB: D1Database;
  ASSET_TTL_SECONDS: string;
  BASE_URL: string;
  // Presigned URL upload (production only — not available in local dev)
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  // OIDC authentication. Only issuer + audience are needed server-side: the
  // Worker verifies inbound JWTs (issuer match + JWKS signature + optional
  // audience) and never initiates an OAuth flow itself, so there is no
  // client ID here. The CLI's login flow has its own client ID via
  // REEARTH_SERVE_CLIENT_ID / `reearth-serve config set clientId`.
  OIDC_ISSUER_URL?: string;
  OIDC_AUDIENCE?: string;
  // JWKS cache TTL (default: 3600s)
  JWKS_CACHE_TTL_SECONDS?: string;
  // Authorization
  CERBOS_ENDPOINT?: string;
  // Shared secret for /api/internal/* (container ↔ worker callbacks).
  // Required in production; without it the internal API rejects every request.
  INTERNAL_API_SECRET?: string;
  // HMAC key for the viewer-authentication cookie of password-protected sites
  // (ADR-013 B7), and the secret ADR-014 §4 reserves for signed URLs. A
  // wrangler secret. Unset ⇒ protected assets answer 503 and protecting one is
  // refused.
  SIGNING_SECRET?: string;
  // Comma-separated exact origins (besides Serve's own) whose pages may read a
  // password-protected file with the visitor's cookie, e.g.
  // "https://viewer.example.com". A path, a wildcard or "null" fails at start.
  CREDENTIALED_ORIGINS?: string;
  // Extraction settings
  EXTRACTION_STUCK_THRESHOLD_SECONDS?: string;
  // SHA-256 backfill of rows stored before ADR-017 (P4): "true" turns it on;
  // the batch size caps how many backfill jobs are open at once (default 2).
  INTEGRITY_BACKFILL_ENABLED?: string;
  INTEGRITY_BACKFILL_BATCH_SIZE?: string;
  // Anonymous (demo-mode) upload toggle. Set to "false" to require login for uploads.
  // Defaults to "true" — read & non-upload operations are not affected.
  ANONYMOUS_UPLOAD_ENABLED?: string;
  // Wildcard suffix that per-asset site hosts live under, e.g.
  // ".serve.reearth.land" (ADR-013 B1). Unset ⇒ site hosts are off.
  SITE_HOST_SUFFIX?: string;
  // Required with SITE_HOST_SUFFIX: the registrable domain the site hosts live
  // under, e.g. "example.net". The Worker refuses to serve when the suffix is
  // not under it or when BASE_URL's host is (ADR-013 B1).
  SITE_REGISTRABLE_DOMAIN?: string;
  // "true" skips that check, for a domain on the Public Suffix List. Logged.
  SITE_DOMAIN_IS_PUBLIC_SUFFIX?: string;
  // Custom domains (ADR-013 B5).
  // Cloudflare for SaaS credentials. Both or neither: with both, verified
  // custom hostnames are registered on the zone and get a DV certificate;
  // with neither, the no-op provisioner just tells the customer to CNAME at
  // the fallback origin and treats the hostname as live. Wrangler secrets.
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  // What a customer CNAMEs their domain at. Cloudflare for SaaS issues a
  // per-zone fallback origin; unset ⇒ the host of BASE_URL.
  SITE_FALLBACK_ORIGIN?: string;
  // DNS-over-HTTPS endpoint for the TXT verification lookup.
  // Default: https://cloudflare-dns.com/dns-query
  SITE_DNS_RESOLVER_URL?: string;
  // Cloudflare Containers
  ARCHIVE_EXTRACTOR?: DurableObjectNamespace;
  THUMBNAIL_GENERATOR?: DurableObjectNamespace;
  // Cloudflare Queues
  EXTRACTION_QUEUE?: Queue;
  THUMBNAIL_QUEUE?: Queue;
}
