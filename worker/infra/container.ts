import { Container } from "@cloudflare/containers";
import type { ArchiveFormat } from "../asset/model";

export interface ContainerLauncher {
  launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void>;
}

export interface ArchiveExtractorParams {
  assetId: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

export class ArchiveExtractorContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;

  // Called via JSRPC from CloudflareContainerLauncher
  async startExtraction(envVars: Record<string, string>): Promise<string> {
    this.envVars = envVars;
    try {
      await this.start();
      return "started";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Container start failed:", msg);
      return `error: ${msg}`;
    }
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

export class CloudflareContainerLauncher implements ContainerLauncher {
  constructor(
    private readonly binding: DurableObjectNamespace,
    private readonly baseUrl: string,
    private readonly r2Config: {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
    },
    private readonly internalApiSecret: string,
  ) {}

  async launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void> {
    const id = this.binding.idFromName(params.assetId);
    const stub = this.binding.get(id) as DurableObjectStub & ArchiveExtractorContainer;

    const envVars = {
      R2_ENDPOINT: this.r2Config.endpoint,
      R2_ACCESS_KEY_ID: this.r2Config.accessKeyId,
      R2_SECRET_ACCESS_KEY: this.r2Config.secretAccessKey,
      R2_BUCKET: this.r2Config.bucket,
      ASSET_ID: params.assetId,
      ARCHIVE_KEY: params.archiveKey,
      ARCHIVE_FILENAME: params.archiveFilename,
      ARCHIVE_FORMAT: params.archiveFormat,
      WORKER_API_URL: this.baseUrl,
      INTERNAL_API_SECRET: this.internalApiSecret,
    };

    await stub.startExtraction(envVars);
  }
}
