/**
 * Environment parsing for the Node runtime, kept separate from the wiring so
 * it can be unit-tested without opening a database or a socket.
 */

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
  anonymousUploadEnabled: boolean;
  assetTtlSeconds: number;
  oidcIssuerUrl: string | undefined;
  oidcAudience: string | undefined;
  /**
   * Wildcard suffix per-asset site hosts live under, e.g.
   * `.serve.reearth.land` or `.localhost:8788` locally (ADR-013 B1). Unset ⇒
   * site hosts are off. Validated (leading dot) when the app is built.
   */
  siteHostSuffix: string | undefined;
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
};

const DEFAULT_PORT = 8788;
const DEFAULT_ASSET_TTL_SECONDS = 3600;

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): NodeConfig {
  const port = intOr(env.PORT, DEFAULT_PORT);
  return {
    port,
    baseUrl: env.BASE_URL || `http://localhost:${port}`,
    // ":memory:" is the default on purpose: an unconfigured run is a scratch
    // run, and a stray SQLite file in the working directory is worse than
    // losing state on restart.
    sqlitePath: env.SQLITE_PATH || ":memory:",
    internalApiSecret: env.INTERNAL_API_SECRET || undefined,
    // Same fail-closed rule as Cloudflare: off unless explicitly "true".
    anonymousUploadEnabled: env.ANONYMOUS_UPLOAD_ENABLED === "true",
    assetTtlSeconds: intOr(env.ASSET_TTL_SECONDS, DEFAULT_ASSET_TTL_SECONDS),
    oidcIssuerUrl: env.OIDC_ISSUER_URL || undefined,
    oidcAudience: env.OIDC_AUDIENCE || undefined,
    siteHostSuffix: env.SITE_HOST_SUFFIX || undefined,
    siteDnsResolverUrl: env.SITE_DNS_RESOLVER_URL || undefined,
    siteFallbackOrigin: env.SITE_FALLBACK_ORIGIN || undefined,
    objectStore: objectStore(env),
    containerLauncher: containerLauncher(env.CONTAINER_LAUNCHER),
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
