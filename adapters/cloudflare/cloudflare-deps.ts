import type { Deps } from "../../core/types";
import { R2FileStorage } from "./storage";
import {
  SqlMetadataStore, SqlJobStore, SqlProjectStore,
  SqlWorkspaceStore, SqlMemberStore, SqlStorageUsageStore, SqlVersionStore,
  SqlCleanupPendingStore,
} from "../sql/stores";
import { R2PresignedUrlGenerator } from "./presigned";
import { CerbosAuthorizer } from "../../core/auth/authorizer";
import { SimpleAuthorizer } from "./authorizer";
import { CloudflareContainerLauncher, type ObjectStoreCredentials } from "./container";
import { CloudflareKeyValue } from "./kv";
import { KeyValueUploadSessionStore, KeyValueSessionStore } from "../../core/kv/stores";
import { CloudflareJobQueue } from "./queues";
import { D1SqlClient } from "./sql";
import { SqlAtomicWrites } from "../sql/writes";

// Anonymous sessions are identity, not content — they must outlive the
// demo asset TTL. A large multipart upload can take many hours between the
// session-stamped create call and the complete call; if the session
// expired in between, the completer would be treated as a different user
// and the upload would 404 at the ownership check.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

// Workers scheduled invocations cap around 1000 subrequests per run; the cron
// spends ~70% of that on the cleanup loop and leaves the rest for retriggers.
const CLEANUP_SUBREQUEST_BUDGET = 700;

/**
 * Cloudflare composition root: the one place that turns Workers bindings into
 * the provider-independent `Deps` the app and the queue/cron handlers run on
 * (ADR-012 §1). Called once per invocation from `runtime/cloudflare/index.ts`.
 */
export function buildDeps(env: Env): Deps {
  const objectStore = r2Credentials(env);
  // One KeyValue per invocation, shared by every store that only needs
  // "JSON blob under a key with a TTL" (ADR-012 §2).
  const kv = new CloudflareKeyValue(env.KV);
  // One SqlClient per invocation; every repository speaks the port, not D1 (ADR-012 §3).
  const sql = new D1SqlClient(env.DB);

  return {
    metadata: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    writes: new SqlAtomicWrites(sql),
    storage: new R2FileStorage(env.STORAGE),
    uploadSessions: new KeyValueUploadSessionStore(kv),
    presignedUrls: objectStore ? new R2PresignedUrlGenerator(objectStore) : null,
    jobs: new SqlJobStore(sql),
    ttlSeconds: parseInt(env.ASSET_TTL_SECONDS, 10) || 3600,
    baseUrl: env.BASE_URL,
    authorizer: env.CERBOS_ENDPOINT
      ? new CerbosAuthorizer(env.CERBOS_ENDPOINT)
      : new SimpleAuthorizer(),
    projects: new SqlProjectStore(sql),
    workspaces: new SqlWorkspaceStore(sql),
    members: new SqlMemberStore(sql),
    extractionQueue: env.EXTRACTION_QUEUE ? new CloudflareJobQueue(env.EXTRACTION_QUEUE) : null,
    thumbnailQueue: env.THUMBNAIL_QUEUE ? new CloudflareJobQueue(env.THUMBNAIL_QUEUE) : null,
    storageUsage: new SqlStorageUsageStore(sql),
    pendingCleanup: new SqlCleanupPendingStore(sql),
    // Fail closed: anonymous uploads stay off unless explicitly enabled. The
    // flag lives as a wrangler secret (not in [vars]) so test campaigns can
    // flip it without touching wrangler.toml: `wrangler secret put
    // ANONYMOUS_UPLOAD_ENABLED` with "true" to open, `wrangler secret delete`
    // to close. Secrets survive deploys, and a forgotten flag shows up in
    // `wrangler secret list` instead of being silently re-enabled.
    anonymousUploadEnabled: env.ANONYMOUS_UPLOAD_ENABLED === "true",
    // Site hosts (ADR-013 B1). Off until the zone carries the wildcard DNS
    // record and a certificate for the suffix; see wrangler.toml.
    siteHostSuffix: env.SITE_HOST_SUFFIX || undefined,

    sessions: new KeyValueSessionStore(kv),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    internalApiSecret: env.INTERNAL_API_SECRET,
    auth: {
      issuer: env.OIDC_ISSUER_URL,
      audience: env.OIDC_AUDIENCE,
      jwksCache: kv,
      jwksCacheTtlSeconds: env.JWKS_CACHE_TTL_SECONDS
        ? parseInt(env.JWKS_CACHE_TTL_SECONDS, 10)
        : undefined,
    },
    containers: new CloudflareContainerLauncher({
      archiveExtractor: env.ARCHIVE_EXTRACTOR ?? null,
      thumbnailGenerator: env.THUMBNAIL_GENERATOR ?? null,
      baseUrl: env.BASE_URL,
      objectStore,
      internalApiSecret: env.INTERNAL_API_SECRET ?? null,
    }),
    extractionStuckThresholdMs:
      parseInt(env.EXTRACTION_STUCK_THRESHOLD_SECONDS || "", 10) * 1000 || DEFAULT_STUCK_THRESHOLD_MS,
    limits: { subrequestBudget: CLEANUP_SUBREQUEST_BUDGET },
  };
}

function r2Credentials(env: Env): ObjectStoreCredentials | null {
  if (!env.R2_S3_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: env.R2_S3_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME || "reearth-serve",
  };
}
