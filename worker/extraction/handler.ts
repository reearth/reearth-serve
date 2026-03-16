import { CloudflareContainerLauncher } from "../infra/container";
import type { ArchiveFormat } from "../asset/model";

export interface ExtractionMessage {
  assetId: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

export async function handleQueue(
  batch: MessageBatch<ExtractionMessage>,
  env: Env,
): Promise<void> {
  const launcher = createLauncher(env);
  if (!launcher) {
    // No container config — retry later
    batch.retryAll();
    return;
  }

  for (const message of batch.messages) {
    try {
      await launcher.launchArchiveExtractor(message.body);
      message.ack();
    } catch (e) {
      console.error(`Failed to launch extractor for ${message.body.assetId}:`, e);
      message.retry();
    }
  }
}

function createLauncher(env: Env): CloudflareContainerLauncher | null {
  if (!env.ARCHIVE_EXTRACTOR || !env.R2_S3_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new CloudflareContainerLauncher(env.ARCHIVE_EXTRACTOR, env.BASE_URL, {
    endpoint: env.R2_S3_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_NAME || "reearth-serve",
  });
}
