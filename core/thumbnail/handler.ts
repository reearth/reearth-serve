import type { ThumbnailMessage } from "./queue";
import { generateThumbnails } from "./generator";
import { imageDimensions } from "./dimensions";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename, THUMBNAIL_CONTENT_TYPE } from "./sizes";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";

// 20 MiB dispatch threshold. Below this we run jSquash inside the Worker;
// above this we hand off to the libvips container. The boundary is intentionally
// well under the 128 MiB Worker memory ceiling because raw-pixel buffers can be
// 4–6× the encoded JPEG size.
const WORKER_INLINE_MAX_BYTES = 20 * 1024 * 1024;

// Decode memory scales with pixels, not file size: RGBA is 4 bytes per pixel
// and the pipeline holds about three copies (decoder WASM heap, JS ImageData,
// resize WASM heap), next to a source buffer of up to 20 MiB. 6 MP peaks near
// 72 MiB of pixels plus the source, under the 128 MiB isolate cap. A 12 MP
// phone photo (~150 MiB peak) goes to the container instead. Runtimes without
// a thumbnail container (Node, which has no isolate cap) skip this limit.
const WORKER_INLINE_MAX_PIXELS = 6_000_000;

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
  if (msg.size <= WORKER_INLINE_MAX_BYTES) {
    const source = await deps.storage.get(msg.sourceKey);
    if (!source) {
      // The source vanished between enqueue and execution. Nothing useful to
      // do — ack via the outer try/catch by throwing so the message retries
      // a couple of times before going to DLQ.
      throw new Error(`Source object not found: ${msg.sourceKey}`);
    }
    const buffer = await new Response(source.body).arrayBuffer();
    const dims = imageDimensions(buffer);
    const pixels = dims ? dims.width * dims.height : 0;
    const fitsInline = pixels > 0 && pixels <= WORKER_INLINE_MAX_PIXELS;
    if (fitsInline || !deps.containers.thumbnailGeneratorAvailable) {
      await generateInWorker(msg, buffer, deps);
      return;
    }
  }
  await deps.containers.generateThumbnails({
    assetId: msg.assetId,
    versionId: msg.versionId,
    sourceKey: msg.sourceKey,
    contentType: msg.contentType,
  });
}

async function generateInWorker(msg: ThumbnailMessage, buffer: ArrayBuffer, deps: Deps): Promise<void> {
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
