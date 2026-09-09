/**
 * Provider-independent port for the out-of-process workers (ADR-012 §1).
 *
 * Archive extraction and large-image thumbnailing run outside the request
 * process. On Cloudflare that is a Container bound to a Durable Object
 * (`adapters/cloudflare/container.ts`); elsewhere it could be a `docker run`, a
 * Cloud Run job, or nothing at all. The consumers only need to know whether a
 * launcher exists and how to ask it for work.
 */
import type { ArchiveFormat } from "../asset/model";

export interface ContainerLauncher {
  /**
   * Whether archive extraction can be launched at all. False means deploy-time
   * configuration is missing — a permanent problem, not a transient one — so
   * callers back off instead of burning their retry budget.
   */
  readonly archiveExtractorAvailable: boolean;
  launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void>;
  /** Runs the out-of-process thumbnail generator. Throws if it is unavailable. */
  generateThumbnails(params: ThumbnailGeneratorParams): Promise<void>;
}

export interface ArchiveExtractorParams {
  assetId: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

export interface ThumbnailGeneratorParams {
  assetId: string;
  versionId?: string;
  sourceKey: string;
  contentType: string;
}
