import type { AtomicWrites, FileStorage, MetadataStore, VersionStore, UploadSessionStore, PresignedUrlGenerator } from "./asset/repository";
import type { JobStore } from "./job/repository";
import type { AuthUser } from "./auth/types";
import type { AuthConfig } from "./auth/middleware";
import type { Authorizer } from "./auth/authorizer";
import type { ProjectStore } from "./project/repository";
import type { WorkspaceStore } from "./workspace/repository";
import type { MemberStore } from "./member/repository";
import type { SessionStore } from "./session/repository";
import type { ContainerLauncher } from "./container/port";
import type { StorageUsageStore } from "./asset/repository";
import type { CleanupPendingStore } from "./cleanup/repository";
import type { JobQueue } from "./queue/port";
import type { KeyValue } from "./kv/port";
import type { SiteHostStore } from "./site/repository";
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
  authorizer: Authorizer;
  projects: ProjectStore;
  workspaces: WorkspaceStore;
  members: MemberStore;
  extractionQueue: JobQueue<ExtractionMessage> | null;
  thumbnailQueue: JobQueue<ThumbnailMessage> | null;
  storageUsage: StorageUsageStore;
  pendingCleanup: CleanupPendingStore;
  anonymousUploadEnabled: boolean;
  /**
   * `SITE_HOST_SUFFIX` — the wildcard suffix site hosts live under, e.g.
   * `.serve.reearth.land` (ADR-013 B1). Undefined ⇒ site hosts are off and
   * upload responses carry no `siteUrl`.
   */
  siteHostSuffix: string | undefined;
  /** Named sites: the `site_hosts` table (ADR-013 B2). */
  siteHosts: SiteHostStore;
  /**
   * General-purpose short-lived cache over the `KeyValue` port (ADR-012 §2).
   * Today it holds site-host resolutions (`host:{hostname}`, 60 s) so a page
   * view on a named site is not a database read. Everything in it must be
   * reconstructible from the source of truth: entries expire, and a provider
   * may evict one at any time.
   */
  cache: KeyValue;
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
 * The whole application's dependency set: everything in `AppEnv.Variables`
 * except the per-request `user` / `sessionId`, plus the request-independent
 * collaborators and configuration that `createApp` and the queue/cron
 * handlers need but individual route handlers never see.
 *
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
  containers: ContainerLauncher;
  /** How long an extraction job may sit untouched before the cron retriggers it. */
  extractionStuckThresholdMs: number;
  limits: Limits;
};

export type AppEnv = {
  Variables: ContextDeps & {
    user: AuthUser | null;
    sessionId: string | null;
    /**
     * True when the request arrived on a site host and was rewritten into
     * `/files/…` (ADR-013 B1). The file handler uses it to mark pinned
     * (version-ID) hosts `noindex`.
     */
    siteHost: boolean;
  };
};
