import type { ThumbnailMessage } from "./queue";
import { generateThumbnails } from "./generator";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename, THUMBNAIL_CONTENT_TYPE } from "./sizes";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";

// 20 MiB dispatch threshold. Below this we run jSquash inside the Worker;
// above this we hand off to the libvips container. The boundary is intentionally
// well under the 128 MiB Worker memory ceiling because raw-pixel buffers can be
// 4–6× the encoded JPEG size.
const WORKER_INLINE_MAX_BYTES = 20 * 1024 * 1024;

export async function handleThumbnailQueue(
  messages: QueueMessage<ThumbnailMessage>[],
  deps: Deps,
): Promise<void> {
  for (const message of messages) {
    try {
      await processMessage(message.body, deps);
      message.ack();
    } catch (e) {
      console.error(`Failed to generate thumbnail for ${message.body.assetId}:`, e);
      message.retry();
    }
  }
}

async function processMessage(msg: ThumbnailMessage, deps: Deps): Promise<void> {
  // Phase 3/4 will fill in real generation. For now this is a placeholder so
  // the queue wiring can be exercised end-to-end without producing bytes.
  if (msg.size <= WORKER_INLINE_MAX_BYTES) {
    await generateInWorker(msg, deps);
  } else {
    await deps.containers.generateThumbnails({
      assetId: msg.assetId,
      versionId: msg.versionId,
      sourceKey: msg.sourceKey,
      contentType: msg.contentType,
    });
  }
}

async function generateInWorker(msg: ThumbnailMessage, deps: Deps): Promise<void> {
  const source = await deps.storage.get(msg.sourceKey);
  if (!source) {
    // The source vanished between enqueue and execution. Nothing useful to
    // do — ack via the outer try/catch by throwing so the message retries
    // a couple of times before going to DLQ.
    throw new Error(`Source object not found: ${msg.sourceKey}`);
  }
  const buffer = await new Response(source.body).arrayBuffer();
  const thumbs = await generateThumbnails(buffer, msg.contentType);
  await Promise.all(
    thumbs.map((thumb) => {
      const filename = thumbnailFilename(thumb.size);
      const key = msg.versionId
        ? versionThumbKey(msg.assetId, msg.versionId, filename)
        : legacyThumbKey(msg.assetId, filename);
      return deps.storage.put(
        key,
        new Response(thumb.data).body as ReadableStream<Uint8Array>,
        THUMBNAIL_CONTENT_TYPE,
        thumb.data.byteLength,
      );
    }),
  );
}
