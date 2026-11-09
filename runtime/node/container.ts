import { createHash } from "node:crypto";
import type {
  ArchiveExtractorParams,
  ContainerLauncher,
  IntegrityVerifierOutcome,
  IntegrityVerifierParams,
  ThumbnailGeneratorParams,
} from "../../core/container/port";
import type { FileStorage } from "../../core/asset/repository";

/**
 * The `CONTAINER_LAUNCHER=none` launcher: there is no out-of-process worker.
 *
 * `archiveExtractorAvailable` is false, which is the signal the extraction
 * consumer already understands — it backs the messages off by five minutes
 * instead of burning their retry budget, and logs why. Large-image thumbnails
 * (the ones that would go to libvips) throw, so the message retries and
 * eventually dead-letters rather than silently producing nothing.
 *
 * Hash verification (ADR-017 §2) needs no container: it is one sequential read,
 * so it runs here, in process, against the same `FileStorage` the app uses, and
 * hands the hash straight back to the consumer.
 *
 * Spawning `docker run` from here is deliberately not implemented: it needs a
 * reachable object store and a callback URL the container can hit, neither of
 * which the in-memory default provides.
 */
export class UnavailableContainerLauncher implements ContainerLauncher {
  readonly archiveExtractorAvailable = false;
  readonly thumbnailGeneratorAvailable = false;
  readonly integrityVerifierAvailable = true;

  constructor(private readonly storage: FileStorage) {}

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

  /** Throws when the object is missing or the read breaks; the consumer retries. */
  async verifyIntegrity(params: IntegrityVerifierParams): Promise<IntegrityVerifierOutcome> {
    const object = await this.storage.get(params.objectKey);
    if (!object) throw new Error(`object ${params.objectKey} not found`);
    const hash = createHash("sha256");
    const reader = (object.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return { sha256: hash.digest("hex") };
  }
}
