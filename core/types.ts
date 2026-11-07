import type { AtomicWrites, FileStorage, MetadataStore, VersionStore, UploadSessionStore, PresignedUrlGenerator } from "./asset/repository";
import type { JobStore } from "./job/repository";
import type { AuthUser, VerifiedCaller } from "./auth/types";
import type { AuthConfig } from "./auth/middleware";
import type { ProjectStore } from "./project/repository";
import type { Tenancy, TenantScope } from "./tenancy/port";
import type { SessionStore } from "./session/repository";
import type { ContainerLauncher } from "./container/port";
import type { StorageUsageStore } from "./asset/repository";
import type { CleanupPendingStore } from "./cleanup/repository";
import type { JobQueue } from "./queue/port";
import type { ExtractionMessage } from "./extraction/handler";
import type { ThumbnailMessage } from "./thumbnail/queue";

/**
 * Dependencies that route handlers read off the request context.
 *
 * These are request-independent objects; they live on the Hono context only
 * because that is how handlers reach them.
 */
export type ContextDeps = {
  metadata: MetadataStore;
  versions: VersionStore;
  /** Multi-row writes that must land together (upload, job status). */
  writes: AtomicWrites;
  storage: FileStorage;
  uploadSessions: UploadSessionStore;
  presignedUrls: PresignedUrlGenerator | null;
  jobs: JobStore;
  ttlSeconds: number;
  baseUrl: string;
  projects: ProjectStore;
  extractionQueue: JobQueue<ExtractionMessage> | null;
  thumbnailQueue: JobQueue<ThumbnailMessage> | null;
  storageUsage: StorageUsageStore;
  pendingCleanup: CleanupPendingStore;
  anonymousUploadEnabled: boolean;
};

/**
 * Runtime quotas that differ per provider.
 *
 * Cloudflare caps a scheduled invocation at ~1000 subrequests; a Node process
 * has no such cap. The cron reads the number from here instead of hardcoding
 * Cloudflare's (ADR-012 §2).
 */
export type Limits = {
  /** Storage/database calls one scheduled invocation may spend. */
  subrequestBudget: number;
};

/**
 * A composition root (`adapters/cloudflare/cloudflare-deps.ts` on Cloudflare) builds this
 * from provider bindings; nothing below this type knows which cloud it runs
 * on. See ADR-012 §1.
 */
export type Deps = ContextDeps & {
  sessions: SessionStore;
  sessionTtlSeconds: number;
  /** Shared secret guarding /api/internal/*. Undefined ⇒ the routes 503. */
  internalApiSecret: string | undefined;
  auth: AuthConfig;
  tenancy: Tenancy;
  containers: ContainerLauncher;
  /** How long an extraction job may sit untouched before the cron retriggers it. */
  extractionStuckThresholdMs: number;
  limits: Limits;
};

export type AppEnv = {
  Variables: ContextDeps & {
    caller: VerifiedCaller | null;
    directory: Tenancy;
    user: AuthUser | null;
    tenancy: TenantScope;
    sessionId: string | null;
  };
};
