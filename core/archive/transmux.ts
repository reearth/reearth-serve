export const GZIP_HEADER_BYTES = 10;
export const GZIP_TRAILER_BYTES = 8;

const OS_UNKNOWN = 0xff;

/**
 * Wrap a zip entry's raw DEFLATE bytes as exactly one gzip member (ADR-011).
 * The trailer comes from the central directory, so nothing is inflated here;
 * the client's decoder checks the CRC. Browsers stop at the first member, so
 * a body must never hold two.
 */
export function gzipMember(rawDeflate: ReadableStream<Uint8Array>, crc32: number, size: number): ReadableStream<Uint8Array> {
  const header = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, OS_UNKNOWN]);
  const trailer = new Uint8Array(GZIP_TRAILER_BYTES);
  const view = new DataView(trailer.buffer);
  view.setUint32(0, crc32 >>> 0, true);
  view.setUint32(4, size % 0x1_0000_0000, true);
  return rawDeflate.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => controller.enqueue(header),
      transform: (chunk, controller) => controller.enqueue(chunk),
      flush: (controller) => controller.enqueue(trailer),
    }),
  );
}
