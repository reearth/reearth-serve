import type { Deps } from "../../core/types";
import type { ExtractionMessage } from "../../core/extraction/handler";
import type { ThumbnailMessage } from "../../core/thumbnail/queue";
import { KeyValueSessionStore, KeyValueUploadSessionStore } from "../../core/kv/stores";
import { CerbosAuthorizer } from "../../core/auth/authorizer";
// SimpleAuthorizer is provider-independent (pure role logic); it still sits
// under adapters/cloudflare/ from the PR6 move. Left where it is rather than
// widening this PR's diff.
import { SimpleAuthorizer } from "../../adapters/cloudflare/authorizer";
import {
  SqlCleanupPendingStore, SqlJobStore, SqlMemberStore, SqlMetadataStore,
  SqlProjectStore, SqlStorageUsageStore, SqlVersionStore, SqlWorkspaceStore,
} from "../../adapters/sql/stores";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import { SqlJobQueue } from "../../adapters/sql/queue";
import { SqlKeyValue } from "../../adapters/sql/kv";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import {
  createSqliteClient,
  DOMAIN_MIGRATIONS_DIR,
  SQL_ADAPTER_MIGRATIONS_DIR,
} from "../../adapters/memory/sqlite-node";
import { UnavailableContainerLauncher } from "./container";
import { loadConfig, type Env, type NodeConfig } from "./config";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// A Node process has no Workers subrequest cap, so the cleanup loop gets a much
// larger budget than Cloudflare's 700. It is still finite: the number bounds how
// much work one cron tick does before yielding.
const CLEANUP_SUBREQUEST_BUDGET = 100_000;

export type NodeRuntime = {
  config: NodeConfig;
  deps: Deps;
  /** Concrete queues, so the cron can drain them (the port has no consumer side). */
  extractionQueue: SqlJobQueue<ExtractionMessage>;
  thumbnailQueue: SqlJobQueue<ThumbnailMessage>;
  /** Concrete KeyValue, so the cron can sweep expired rows. */
  kv: SqlKeyValue;
};

/**
 * Node composition root (ADR-012 §1): the one place that turns environment
 * variables into `Deps`. Everything below it is the same code the Worker runs.
 *
 * The backing services are the provider-independent adapters — SQLite for the
 * repositories, the `kv` table for sessions and the JWKS cache, the
 * `queue_messages` outbox for jobs, and an in-process object store until an S3
 * adapter lands.
 */
export function buildNodeRuntime(env: Env = process.env): NodeRuntime {
  const config = loadConfig(env);

  // The domain schema plus the queue/kv tables that only exist off Cloudflare.
  const sql = createSqliteClient(config.sqlitePath, [
    DOMAIN_MIGRATIONS_DIR,
    SQL_ADAPTER_MIGRATIONS_DIR,
  ]);

  if (config.objectStore) {
    console.warn(
      "OBJECT_STORE_* is set but no S3 adapter exists yet; falling back to in-process file storage.",
    );
  }

  const kv = new SqlKeyValue(sql);
  const extractionQueue = new SqlJobQueue<ExtractionMessage>(sql, "extraction");
  const thumbnailQueue = new SqlJobQueue<ThumbnailMessage>(sql, "thumbnail");

  const deps: Deps = {
    metadata: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    writes: new SqlAtomicWrites(sql),
    storage: new MemoryFileStorage(),
    uploadSessions: new KeyValueUploadSessionStore(kv),
    // No presigned uploads without an object store that can sign URLs; the
    // create-session route reports the feature off, as it does on a Cloudflare
    // deployment without R2 S3 credentials.
    presignedUrls: null,
    jobs: new SqlJobStore(sql),
    ttlSeconds: config.assetTtlSeconds,
    baseUrl: config.baseUrl,
    authorizer: env.CERBOS_ENDPOINT
      ? new CerbosAuthorizer(env.CERBOS_ENDPOINT)
      : new SimpleAuthorizer(),
    projects: new SqlProjectStore(sql),
    workspaces: new SqlWorkspaceStore(sql),
    members: new SqlMemberStore(sql),
    extractionQueue,
    thumbnailQueue,
    storageUsage: new SqlStorageUsageStore(sql),
    pendingCleanup: new SqlCleanupPendingStore(sql),
    anonymousUploadEnabled: config.anonymousUploadEnabled,
    sessions: new KeyValueSessionStore(kv),
    sessionTtlSeconds: SESSION_TTL_SECONDS,
    internalApiSecret: config.internalApiSecret,
    auth: {
      issuer: config.oidcIssuerUrl,
      audience: config.oidcAudience,
      jwksCache: kv,
    },
    containers: new UnavailableContainerLauncher(),
    extractionStuckThresholdMs: STUCK_THRESHOLD_MS,
    limits: { subrequestBudget: CLEANUP_SUBREQUEST_BUDGET },
  };

  return { config, deps, extractionQueue, thumbnailQueue, kv };
}
