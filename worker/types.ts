import type { FileStorage, MetadataStore, VersionStore, UploadSessionStore, PresignedUrlGenerator } from "./asset/repository";
import type { JobStore } from "./job/repository";
import type { AuthUser } from "./auth/types";
import type { AuthConfig } from "./auth/middleware";
import type { Authorizer } from "./auth/authorizer";
import type { ProjectStore } from "./project/repository";
import type { WorkspaceStore } from "./workspace/repository";
import type { MemberStore } from "./member/repository";
import type { SessionStore } from "./session/repository";
import type { ContainerLauncher } from "./infra/container";
import type { StorageUsageStore } from "./infra/d1";
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
};

/**
 * The whole application's dependency set: everything in `AppEnv.Variables`
 * except the per-request `user` / `sessionId`, plus the request-independent
 * collaborators and configuration that `createApp` and the queue/cron
 * handlers need but individual route handlers never see.
 *
 * A composition root (`infra/cloudflare-deps.ts` on Cloudflare) builds this
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
};

export type AppEnv = {
  Variables: ContextDeps & {
    user: AuthUser | null;
    sessionId: string | null;
  };
};
