import type {
  ArchiveExtractorParams,
  ContainerLauncher,
  ThumbnailGeneratorParams,
} from "../../core/container/port";

/**
 * The `CONTAINER_LAUNCHER=none` launcher: there is no out-of-process worker.
 *
 * `archiveExtractorAvailable` is false, which is the signal the extraction
 * consumer already understands — it backs the messages off by five minutes
 * instead of burning their retry budget, and logs why. Large-image thumbnails
 * (the ones that would go to libvips) throw, so the message retries and
 * eventually dead-letters rather than silently producing nothing.
 *
 * Spawning `docker run` from here is deliberately not implemented: it needs a
 * reachable object store and a callback URL the container can hit, neither of
 * which the in-memory default provides.
 */
export class UnavailableContainerLauncher implements ContainerLauncher {
  readonly archiveExtractorAvailable = false;

  async launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void> {
    throw new Error(
      `no container launcher configured; cannot extract ${params.archiveFilename} (asset ${params.assetId})`,
    );
  }

  async generateThumbnails(params: ThumbnailGeneratorParams): Promise<void> {
    throw new Error(
      `no container launcher configured; cannot thumbnail ${params.sourceKey} (asset ${params.assetId})`,
    );
  }
}
