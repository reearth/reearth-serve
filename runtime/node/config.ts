import { parseDeliveryTokenKeys, type DeliveryKeyRing } from "../../core/access/token";

/**
 * Environment parsing for the Node runtime, kept separate from the wiring so
 * it can be unit-tested without opening a database or a socket.
 */
import { parseTenancyConfig, type TenancyConfig } from "../../adapters/tenancy";

import { parseCredentialedOrigins } from "../../core/file/cors";
import { checkSiteIsolation } from "../../core/site/isolation";
import { DEFAULT_BACKFILL_BATCH_SIZE } from "../../core/integrity/backfill";

export type ContainerLauncherKind = "none";

export type ObjectStoreConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
};

export type NodeConfig = {
  port: number;
  baseUrl: string;
  sqlitePath: string;
  internalApiSecret: string | undefined;
  /**
   * `SIGNING_SECRET` — HMAC key for the viewer-authentication cookie of
   * password-protected sites (ADR-013 B7), and the secret ADR-014 §4 reserves
   * for signed URLs. Unset ⇒ protected assets answer 503 and protecting one is
   * refused.
   */
  signingSecret: string | undefined;
  /** `CREDENTIALED_ORIGINS`, parsed; a malformed entry fails `loadConfig`. */
  credentialedOrigins: string[];
  anonymousUploadEnabled: boolean;
  /**
   * `TRUST_PROXY=true`: a reverse proxy in front sets `X-Forwarded-For` (or
   * `CF-Connecting-IP`). Otherwise the runtime replaces both with the socket
   * address before the app runs.
   */
  trustProxy: boolean;
  assetTtlSeconds: number;
  oidcIssuerUrl: string | undefined;
  oidcAudience: string | undefined;
  tenancy: TenancyConfig;
  /**
   * Wildcard suffix per-asset site hosts live under, e.g.
   * `.sites.example.net` or `.localhost:8788` locally (ADR-013 B1). Unset ⇒
   * site hosts are off. Validated (leading dot) when the app is built.
   */
  siteHostSuffix: string | undefined;
  /**
   * `SITE_DOMAIN_IS_PUBLIC_SUFFIX=true` skipped the site-isolation check, which
   * the runtime logs at start. Without it, a suffix on the API's own
   * registrable domain fails `loadConfig` (ADR-013 B1).
   */
  siteDomainIsPublicSuffix: boolean;
  /**
   * Custom domains (ADR-013 B5). `siteDnsResolverUrl` is the DNS-over-HTTPS
   * endpoint the TXT verification is asked of — configurable so an operator
   * can use their own resolver, and so the e2e run can point it at a mock.
   * `siteFallbackOrigin` is what a customer CNAMEs at; unset ⇒ the apex.
   *
   * There is no certificate provisioner on this runtime: TLS for a customer's
   * hostname is terminated by whatever sits in front of the process.
   */
  siteDnsResolverUrl: string | undefined;
  siteFallbackOrigin: string | undefined;
  /**
   * Parsed `OBJECT_STORE_*`. Reserved for the S3 adapter; until that exists the
   * runtime logs and falls back to in-process storage when it is set.
   */
  objectStore: ObjectStoreConfig | null;
  containerLauncher: ContainerLauncherKind;
  /**
   * `INTEGRITY_BACKFILL_ENABLED=true`: the cron hashes rows stored before
   * ADR-017, at most `INTEGRITY_BACKFILL_BATCH_SIZE` jobs open at once
   * (ADR-017 P4). Off by default.
   */
  backfill: { enabled: boolean; batchSize: number };
  deliveryTokenKeys: DeliveryKeyRing | null;
};

const DEFAULT_PORT = 8788;
const DEFAULT_ASSET_TTL_SECONDS = 3600;

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): NodeConfig {
  const port = intOr(env.PORT, DEFAULT_PORT);
  const isolation = checkSiteIsolation(env);
  return {
    port,
    baseUrl: env.BASE_URL || `http://localhost:${port}`,
    // ":memory:" is the default on purpose: an unconfigured run is a scratch
    // run, and a stray SQLite file in the working directory is worse than
    // losing state on restart.
    sqlitePath: env.SQLITE_PATH || ":memory:",
    internalApiSecret: env.INTERNAL_API_SECRET || undefined,
    signingSecret: env.SIGNING_SECRET || undefined,
    credentialedOrigins: parseCredentialedOrigins(env.CREDENTIALED_ORIGINS),
    // Same fail-closed rule as Cloudflare: off unless explicitly "true".
    anonymousUploadEnabled: env.ANONYMOUS_UPLOAD_ENABLED === "true",
    trustProxy: env.TRUST_PROXY === "true",
    assetTtlSeconds: intOr(env.ASSET_TTL_SECONDS, DEFAULT_ASSET_TTL_SECONDS),
    oidcIssuerUrl: env.OIDC_ISSUER_URL || undefined,
    oidcAudience: env.OIDC_AUDIENCE || undefined,
    siteHostSuffix: env.SITE_HOST_SUFFIX || undefined,
    siteDomainIsPublicSuffix: isolation.publicSuffixOverride,
    siteDnsResolverUrl: env.SITE_DNS_RESOLVER_URL || undefined,
    siteFallbackOrigin: env.SITE_FALLBACK_ORIGIN || undefined,
    tenancy: parseTenancyConfig(env),
    objectStore: objectStore(env),
    containerLauncher: containerLauncher(env.CONTAINER_LAUNCHER),
    backfill: {
      enabled: env.INTEGRITY_BACKFILL_ENABLED === "true",
      batchSize: intOr(env.INTEGRITY_BACKFILL_BATCH_SIZE, DEFAULT_BACKFILL_BATCH_SIZE),
    },
    deliveryTokenKeys: env.DELIVERY_TOKEN_KEYS ? parseDeliveryTokenKeys(env.DELIVERY_TOKEN_KEYS) : null,
  };
}

function objectStore(env: Env): ObjectStoreConfig | null {
  const { OBJECT_STORE_ENDPOINT, OBJECT_STORE_ACCESS_KEY_ID, OBJECT_STORE_SECRET_ACCESS_KEY } = env;
  if (!OBJECT_STORE_ENDPOINT || !OBJECT_STORE_ACCESS_KEY_ID || !OBJECT_STORE_SECRET_ACCESS_KEY) {
    return null;
  }
  return {
    endpoint: OBJECT_STORE_ENDPOINT,
    accessKeyId: OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: OBJECT_STORE_SECRET_ACCESS_KEY,
    bucket: env.OBJECT_STORE_BUCKET || "reearth-serve",
    region: env.OBJECT_STORE_REGION || "auto",
    pathStyle: env.OBJECT_STORE_PATH_STYLE === "true",
  };
}

function containerLauncher(value: string | undefined): ContainerLauncherKind {
  const kind = value || "none";
  if (kind !== "none") {
    // Deliberately not a silent fallback: a deployment that asked for docker
    // and got a no-op would look healthy while every extraction stalled.
    throw new Error(
      `CONTAINER_LAUNCHER="${kind}" is not supported by the Node runtime (only "none" is implemented)`,
    );
  }
  return kind;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
