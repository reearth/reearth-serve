import type { Deps } from "../types";
import { R2FileStorage } from "./storage";
import { KVUploadSessionStore, KVSessionStore } from "./metadata";
import {
  D1MetadataStore, D1JobStore, D1ProjectStore,
  D1WorkspaceStore, D1MemberStore, D1StorageUsageStore, D1VersionStore,
  D1CleanupPendingStore,
} from "./d1";
import { R2PresignedUrlGenerator } from "./presigned";
import { CerbosAuthorizer } from "../auth/authorizer";
import { SimpleAuthorizer } from "./authorizer";
import { CloudflareContainerLauncher, type ObjectStoreCredentials } from "./container";
import { KVJwksCache } from "./kv-cache";
import { CloudflareJobQueue } from "./queues";
import { D1SqlClient } from "./sql";
import { D1AtomicWrites } from "./d1-writes";

// Anonymous sessions are identity, not content — they must outlive the
// demo asset TTL. A large multipart upload can take many hours between the
// session-stamped create call and the complete call; if the session
// expired in between, the completer would be treated as a different user
// and the upload would 404 at the ownership check.
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Cloudflare composition root: the one place that turns Workers bindings into
 * the provider-independent `Deps` the app and the queue/cron handlers run on
 * (ADR-012 §1). Called once per invocation from `worker/index.ts`.
 */
export function buildDeps(env: Env): Deps {
  const objectStore = r2Credentials(env);
  // One SqlClient per invocation; every repository speaks the port, not D1 (ADR-012 §3).
  const sql = new D1SqlClient(env.DB);

  return {
    metadata: new D1MetadataStore(sql),
    versions: new D1VersionStore(sql),
    writes: new D1AtomicWrites(sql),
    storage: new R2FileStorage(env.STORAGE),
    uploadSessions: new KVUploadSessionStore(env.KV),
    presignedUrls: objectStore ? new R2PresignedUrlGenerator(objectStore) : null,
    jobs: new D1JobStore(sql),
    ttlSeconds: parseInt(env.ASSET_TTL_SECONDS, 10) || 3600,
    baseUrl: env.BASE_URL,
    authorizer: env.CERBOS_ENDPOINT
      ? new CerbosAuthorizer(env.CERBOS_ENDPOINT)
      : new SimpleAuthorizer(),
    projects: new D1ProjectStore(sql),
    workspaces: new D1WorkspaceStore(sql),
    members: new D1MemberStore(sql),
    extractionQueue: env.EXTRACTION_QUEUE ? new CloudflareJobQueue(env.EXTRACTION_QUEUE) : null,
    thumbnailQueue: env.THUMBNAIL_QUEUE ? new CloudflareJobQueue(env.THUMBNAIL_QUEUE) : null,
    storageUsage: new D1StorageUsageStore(sql),
    pendingCleanup: new D1CleanupPendingStore(sql),
    // Fail closed: anonymous uploads stay off unless explicitly enabled. The
    // flag lives as a wrangler secret (not in [vars]) so test campaigns can
    // flip it without touching wrangler.toml: `wrangler secret put
    // ANONYMOUS_UPLOAD_ENABLED` with "true" to open, `wrangler secret delete`
    // to close. Secrets survive deploys, and a forgotten flag shows up in
    // `wrangler secret list` instead of being silently re-enabled.
    anonymousUploadEnabled: env.ANONYMOUS_UPLOAD_ENABLED === "true",

    sessions: new KVSessionStore(env.KV),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    internalApiSecret: env.INTERNAL_API_SECRET,
    auth: {
      issuer: env.OIDC_ISSUER_URL,
      audience: env.OIDC_AUDIENCE,
      jwksCache: new KVJwksCache(env.KV),
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
