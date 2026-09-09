import { Container } from "@cloudflare/containers";
import type { ArchiveFormat } from "../asset/model";

export interface ContainerLauncher {
  /**
   * Whether archive extraction can be launched at all. False means deploy-time
   * configuration is missing — a permanent problem, not a transient one — so
   * callers back off instead of burning their retry budget.
   */
  readonly archiveExtractorAvailable: boolean;
  launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void>;
  /** Runs the out-of-Worker thumbnail generator. Throws if it is unavailable. */
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

export interface ObjectStoreCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

// Hard ceiling on a single extraction run. Activity renewal (below) keeps the
// container alive while the Go process works, so a hung process would
// otherwise be renewed forever. 24h matches the cleanup cron's stuck-job
// threshold (EXTRACTION_STUCK_THRESHOLD_SECONDS default).
const EXTRACTOR_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class ArchiveExtractorContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;

  private extractionStartedAt = 0;

  // Called via JSRPC from CloudflareContainerLauncher
  async startExtraction(envVars: Record<string, string>): Promise<string> {
    this.envVars = envVars;
    this.extractionStartedAt = Date.now();
    try {
      await this.start();
      return "started";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Container start failed:", msg);
      return `error: ${msg}`;
    }
  }

  // Extraction is a background job: after startExtraction() the container
  // receives no inbound requests, so the activity timeout always expires
  // mid-work and the default implementation would kill a healthy extraction
  // after `sleepAfter` (observed as jobs silently stuck in `running`). The Go
  // process exits on its own when extraction completes or fails, so on expiry
  // we probe its health endpoint: alive → renew and keep working, gone →
  // stop the container.
  override async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    const expired =
      this.extractionStartedAt > 0 &&
      Date.now() - this.extractionStartedAt > EXTRACTOR_MAX_LIFETIME_MS;
    if (!expired) {
      try {
        const res = await this.containerFetch("http://container/health", { method: "GET" });
        if (res.ok) {
          this.renewActivityTimeout();
          return;
        }
      } catch {
        // Probe failed — the process is gone or wedged; fall through to stop.
      }
    }
    await this.stop();
  }
}

// Synchronous thumbnail generator. Unlike the extractor (long-running,
// callback-based), thumbnail generation is short enough to hold open as a
// regular HTTP request — the queue consumer awaits the response before acking.
export class ThumbnailContainer extends Container {
  defaultPort = 8080;
  // Idle quickly: thumbnail generation is bursty and short, so we don't keep
  // instances warm long after a batch completes. Cost-vs-cold-start tradeoff
  // favors short here because we already paid the queue-dispatch latency.
  sleepAfter = "2m";
  enableInternet = true;

  async generate(envVars: Record<string, string>, request: object): Promise<Response> {
    this.envVars = envVars;
    await this.startAndWaitForPorts(8080);
    return this.containerFetch(
      new Request("http://container/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }
}

export interface CloudflareContainerConfig {
  archiveExtractor: DurableObjectNamespace | null;
  thumbnailGenerator: DurableObjectNamespace | null;
  baseUrl: string;
  objectStore: ObjectStoreCredentials | null;
  internalApiSecret: string | null;
}

export class CloudflareContainerLauncher implements ContainerLauncher {
  constructor(private readonly config: CloudflareContainerConfig) {}

  get archiveExtractorAvailable(): boolean {
    return Boolean(
      this.config.archiveExtractor &&
      this.config.objectStore &&
      // Without the shared secret the container cannot authenticate its
      // status callbacks, so launching it would just produce 401s.
      this.config.internalApiSecret,
    );
  }

  async launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void> {
    const { archiveExtractor, objectStore, internalApiSecret } = this.config;
    if (!archiveExtractor || !objectStore || !internalApiSecret) {
      throw new Error("archive extractor container is not configured");
    }

    const id = archiveExtractor.idFromName(params.assetId);
    const stub = archiveExtractor.get(id) as DurableObjectStub & ArchiveExtractorContainer;

    const envVars = {
      R2_ENDPOINT: objectStore.endpoint,
      R2_ACCESS_KEY_ID: objectStore.accessKeyId,
      R2_SECRET_ACCESS_KEY: objectStore.secretAccessKey,
      R2_BUCKET: objectStore.bucket,
      ASSET_ID: params.assetId,
      ARCHIVE_KEY: params.archiveKey,
      ARCHIVE_FILENAME: params.archiveFilename,
      ARCHIVE_FORMAT: params.archiveFormat,
      WORKER_API_URL: this.config.baseUrl,
      INTERNAL_API_SECRET: internalApiSecret,
    };

    // startExtraction catches container.start() failures internally (a thrown
    // error would otherwise be swallowed by the JSRPC boundary) and reports
    // them in its return value. Ignoring it meant a capacity-exhausted start
    // ("no instance available") looked like success: the queue message was
    // acked and the job sat in `pending` until the cleanup cron noticed.
    const result = await stub.startExtraction(envVars);
    if (result !== "started") {
      throw new Error(`extractor container failed to start: ${result}`);
    }
  }

  async generateThumbnails(params: ThumbnailGeneratorParams): Promise<void> {
    const { thumbnailGenerator, objectStore } = this.config;
    if (!thumbnailGenerator) {
      throw new Error("THUMBNAIL_GENERATOR binding is not configured");
    }
    if (!objectStore) {
      throw new Error("R2 S3 credentials are not configured");
    }

    // One DO instance per (asset, version) so concurrent requests for the same
    // source coalesce on a single container. Bursts targeting different assets
    // spread across max_instances.
    const idName = params.versionId ? `${params.assetId}:${params.versionId}` : params.assetId;
    const id = thumbnailGenerator.idFromName(idName);
    const stub = thumbnailGenerator.get(id) as DurableObjectStub & {
      generate(envVars: Record<string, string>, request: object): Promise<Response>;
    };

    const envVars = {
      R2_ENDPOINT: objectStore.endpoint,
      R2_ACCESS_KEY_ID: objectStore.accessKeyId,
      R2_SECRET_ACCESS_KEY: objectStore.secretAccessKey,
      R2_BUCKET: objectStore.bucket,
    };
    const request = {
      assetId: params.assetId,
      versionId: params.versionId ?? "",
      sourceKey: params.sourceKey,
      contentType: params.contentType,
    };
    const res = await stub.generate(envVars, request);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`container returned ${res.status}: ${body}`);
    }
  }
}
