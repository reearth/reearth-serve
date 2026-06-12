import { CloudflareContainerLauncher } from "../infra/container";
import { D1JobStore } from "../infra/d1";
import { retryDelaySeconds } from "./backoff";
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
    // No container config — a deploy-time problem, not a transient one.
    // Spread retries out so the batch doesn't burn its budget while broken.
    batch.retryAll({ delaySeconds: 300 });
    return;
  }

  for (const message of batch.messages) {
    try {
      await launcher.launchArchiveExtractor(message.body);
      message.ack();
    } catch (e) {
      console.error(`Failed to launch extractor for ${message.body.assetId} (attempt ${message.attempts}):`, e);
      // Refresh the job's updated_at so the cleanup cron can tell "waiting
      // for capacity, queue is on it" from "orphaned" — without this, the
      // cron re-enqueues the still-pending job every tick and each pass
      // burns one of its MAX_RETRIES. The cron only takes over once the
      // queue gives up (max_retries → DLQ) and the touches stop.
      await touchPendingJob(env, message.body.assetId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function touchPendingJob(env: Env, assetId: string): Promise<void> {
  if (!env.DB) return;
  try {
    const jobs = new D1JobStore(env.DB);
    const job = await jobs.find(assetId);
    if (job && job.status === "pending") {
      job.updatedAt = Date.now();
      await jobs.save(job);
    }
  } catch (e) {
    console.error(`Failed to touch pending job ${assetId}:`, e);
  }
}

function createLauncher(env: Env): CloudflareContainerLauncher | null {
  if (!env.ARCHIVE_EXTRACTOR || !env.R2_S3_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  if (!env.INTERNAL_API_SECRET) {
    // Without the shared secret the container cannot authenticate its
    // status callbacks, so launching it would just produce 401s.
    console.error("Cannot launch extractor: INTERNAL_API_SECRET is not configured");
    return null;
  }
  return new CloudflareContainerLauncher(
    env.ARCHIVE_EXTRACTOR,
    env.BASE_URL,
    {
      endpoint: env.R2_S3_ENDPOINT,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET_NAME || "reearth-serve",
    },
    env.INTERNAL_API_SECRET,
  );
}
