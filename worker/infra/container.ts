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

// TODO: Implement CF Container launch via Cloudflare Containers API.
// For now, this is a placeholder that logs the params.
// The actual implementation will use the Cloudflare Containers binding
// to start the archive-extractor container with the appropriate env vars.
export class CloudflareContainerLauncher implements ContainerLauncher {
  constructor(
    private readonly baseUrl: string,
    private readonly r2Config: {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
    },
  ) {}

  async launchArchiveExtractor(params: ArchiveExtractorParams): Promise<void> {
    // The container will be launched with these environment variables:
    const _env = {
      R2_ENDPOINT: this.r2Config.endpoint,
      R2_ACCESS_KEY_ID: this.r2Config.accessKeyId,
      R2_SECRET_ACCESS_KEY: this.r2Config.secretAccessKey,
      R2_BUCKET: this.r2Config.bucket,
      ASSET_ID: params.assetId,
      ARCHIVE_KEY: params.archiveKey,
      ARCHIVE_FILENAME: params.archiveFilename,
      ARCHIVE_FORMAT: params.archiveFormat,
      WORKER_API_URL: this.baseUrl,
    };

    // TODO: Use Cloudflare Containers API to start the container.
    // The Containers API is still in beta; the binding interface may look like:
    //   await this.container.start({ image: "archive-extractor", env: _env });
    console.log("Container launch requested:", JSON.stringify(params));
  }
}
