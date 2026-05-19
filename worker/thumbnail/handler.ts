import type { ThumbnailMessage } from "./queue";
import { generateThumbnails } from "./generator";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename, THUMBNAIL_CONTENT_TYPE } from "./sizes";

// 20 MiB dispatch threshold. Below this we run jSquash inside the Worker;
// above this we hand off to the libvips container. The boundary is intentionally
// well under the 128 MiB Worker memory ceiling because raw-pixel buffers can be
// 4–6× the encoded JPEG size.
const WORKER_INLINE_MAX_BYTES = 20 * 1024 * 1024;

export async function handleThumbnailQueue(
  batch: MessageBatch<ThumbnailMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessage(message.body, env);
      message.ack();
    } catch (e) {
      console.error(`Failed to generate thumbnail for ${message.body.assetId}:`, e);
      message.retry();
    }
  }
}

async function processMessage(msg: ThumbnailMessage, env: Env): Promise<void> {
  // Phase 3/4 will fill in real generation. For now this is a placeholder so
  // the queue wiring can be exercised end-to-end without producing bytes.
  if (msg.size <= WORKER_INLINE_MAX_BYTES) {
    await generateInWorker(msg, env);
  } else {
    await generateInContainer(msg, env);
  }
}

async function generateInWorker(msg: ThumbnailMessage, env: Env): Promise<void> {
  const source = await env.STORAGE.get(msg.sourceKey);
  if (!source) {
    // The source vanished between enqueue and execution. Nothing useful to
    // do — ack via the outer try/catch by throwing so the message retries
    // a couple of times before going to DLQ.
    throw new Error(`Source object not found: ${msg.sourceKey}`);
  }
  const buffer = await source.arrayBuffer();
  const thumbs = await generateThumbnails(buffer, msg.contentType);
  await Promise.all(
    thumbs.map((thumb) => {
      const filename = thumbnailFilename(thumb.size);
      const key = msg.versionId
        ? versionThumbKey(msg.assetId, msg.versionId, filename)
        : legacyThumbKey(msg.assetId, filename);
      return env.STORAGE.put(key, thumb.data, {
        httpMetadata: { contentType: THUMBNAIL_CONTENT_TYPE },
      });
    }),
  );
}

async function generateInContainer(msg: ThumbnailMessage, env: Env): Promise<void> {
  if (!env.THUMBNAIL_GENERATOR) {
    throw new Error("THUMBNAIL_GENERATOR binding is not configured");
  }
  if (!env.R2_S3_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 S3 credentials are not configured");
  }

  // One DO instance per (asset, version) so concurrent requests for the same
  // source coalesce on a single container. Bursts targeting different assets
  // spread across max_instances.
  const idName = msg.versionId ? `${msg.assetId}:${msg.versionId}` : msg.assetId;
  const id = env.THUMBNAIL_GENERATOR.idFromName(idName);
  const stub = env.THUMBNAIL_GENERATOR.get(id) as DurableObjectStub & {
    generate(envVars: Record<string, string>, request: object): Promise<Response>;
  };

  const envVars = {
    R2_ENDPOINT: env.R2_S3_ENDPOINT,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: env.R2_BUCKET_NAME || "reearth-serve",
  };
  const request = {
    assetId: msg.assetId,
    versionId: msg.versionId ?? "",
    sourceKey: msg.sourceKey,
    contentType: msg.contentType,
  };
  const res = await stub.generate(envVars, request);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`container returned ${res.status}: ${body}`);
  }
}
