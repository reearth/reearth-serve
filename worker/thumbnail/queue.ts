import { isThumbnailableContentType } from "./sizes";

export interface ThumbnailMessage {
  assetId: string;
  versionId?: string;
  sourceKey: string;
  contentType: string;
  size: number;
}

// Best-effort enqueue. Failure is logged and swallowed — the upload itself
// must not be derailed by a queue outage. The version row still lands; the
// user can trigger regeneration later if needed.
export async function enqueueThumbnail(
  queue: Queue | null,
  msg: ThumbnailMessage,
): Promise<void> {
  if (!queue) return;
  if (!isThumbnailableContentType(msg.contentType)) return;
  try {
    await queue.send(msg);
  } catch (e) {
    console.error("Failed to enqueue thumbnail generation:", e);
  }
}
