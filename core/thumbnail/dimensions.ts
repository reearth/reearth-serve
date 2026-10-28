// Width and height from an encoded image's header, without decoding pixels.
// Returns null for unknown formats or a header too short or malformed to read.
export function imageDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  const b = new Uint8Array(buffer);
  const v = new DataView(buffer);
  const ascii = (at: number, s: string) =>
    b.length >= at + s.length && [...s].every((ch, i) => b[at + i] === ch.charCodeAt(0));

  // PNG: IHDR is always the first chunk.
  if (ascii(1, "PNG") && b.length >= 24) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }

  if (ascii(0, "GIF8") && b.length >= 10) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }

  if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X") && b.length >= 30) {
      const u24 = (at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
      return { width: u24(24) + 1, height: u24(27) + 1 };
    }
    if (ascii(12, "VP8L") && b.length >= 25) {
      return {
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    }
    if (ascii(12, "VP8 ") && b.length >= 30) {
      return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    }
    return null;
  }

  // JPEG: walk the marker segments to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  const bytes = (...parts: (number[] | string)[]) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p))).buffer;

  test("reads PNG IHDR", () => {
    const png = bytes([0x89], "PNG\r\n\x1a\n", [0, 0, 0, 13], "IHDR", [0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8]);
    expect(imageDimensions(png)).toEqual({ width: 4000, height: 3000 });
  });

  test("reads GIF logical screen", () => {
    expect(imageDimensions(bytes("GIF89a", [0x40, 0x01, 0xf0, 0x00]))).toEqual({ width: 320, height: 240 });
  });

  test("reads JPEG SOF after an APP segment", () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1, 0x00, 0x04, 0xaa, 0xbb], // APP1, 2 payload bytes
      [0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03],
    );
    expect(imageDimensions(jpeg)).toEqual({ width: 4000, height: 3000 });
  });

  test("reads WebP VP8X canvas size", () => {
    const webp = bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X", [10, 0, 0, 0], [0, 0, 0, 0], [0x9f, 0x0f, 0x00], [0xb7, 0x0b, 0x00]);
    expect(imageDimensions(webp)).toEqual({ width: 4000, height: 3000 });
  });

  test("returns null for unknown or truncated input", () => {
    expect(imageDimensions(bytes("hello world"))).toBeNull();
    expect(imageDimensions(bytes([0xff, 0xd8, 0xff]))).toBeNull();
  });
}
