const COMPRESSIBLE_EXTENSIONS = new Set([
  "json", "geojson", "topojson", "csv", "tsv",
  "xml", "kml", "gml", "czml",
  "html", "htm", "js", "mjs", "css",
  "svg", "txt", "md", "yaml", "yml",
]);

const MIN_SIZE = 1024; // 1KB

export function shouldCompress(filename: string, size: number): boolean {
  if (size < MIN_SIZE) return false;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return COMPRESSIBLE_EXTENSIONS.has(ext);
}

export function decompressStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("shouldCompress returns true for large JSON", () => {
    expect(shouldCompress("data.json", 2000)).toBe(true);
  });

  test("shouldCompress returns true for GeoJSON", () => {
    expect(shouldCompress("map.geojson", 5000)).toBe(true);
  });

  test("shouldCompress returns true for GML", () => {
    expect(shouldCompress("data.gml", 2000)).toBe(true);
  });

  test("shouldCompress returns true for CSV", () => {
    expect(shouldCompress("data.csv", 10000)).toBe(true);
  });

  test("shouldCompress returns false for small file", () => {
    expect(shouldCompress("tiny.json", 100)).toBe(false);
  });

  test("shouldCompress returns false for PNG", () => {
    expect(shouldCompress("image.png", 50000)).toBe(false);
  });

  test("shouldCompress returns false for ZIP", () => {
    expect(shouldCompress("archive.zip", 50000)).toBe(false);
  });

  test("shouldCompress returns false for JPEG", () => {
    expect(shouldCompress("photo.jpg", 50000)).toBe(false);
  });

  test("decompressStream decompresses gzip data", async () => {
    const original = new TextEncoder().encode("hello ".repeat(200));

    // Compress with CompressionStream, then decompress with decompressStream
    const compressedStream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(original); c.close(); },
    }).pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);

    const decompressed = decompressStream(compressedStream);

    const reader = decompressed.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    expect(result).toEqual(original);
  });
}
