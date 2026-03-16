export function parseRange(header: string | undefined): { offset: number; length: number } | null {
  if (!header) return null;

  const match = header.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;

  if (end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }

  return { offset: start, length: Number.MAX_SAFE_INTEGER };
}

export function sliceStream(
  stream: ReadableStream<Uint8Array>,
  offset: number,
  length: number,
  totalSize?: number,
): ReadableStream<Uint8Array> {
  const actualLength = totalSize ? Math.min(length, totalSize - offset) : length;
  let skipped = 0;
  let sent = 0;

  return new ReadableStream({
    async start() {},
    async pull(controller) {
      const reader = (this as any)._reader ?? ((this as any)._reader = stream.getReader());

      while (sent < actualLength) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }

        const chunk = value;
        const chunkStart = skipped;
        const chunkEnd = skipped + chunk.length;

        if (chunkEnd <= offset) {
          skipped += chunk.length;
          continue;
        }

        const sliceStart = Math.max(0, offset - chunkStart);
        const remaining = actualLength - sent;
        const sliceEnd = Math.min(chunk.length, sliceStart + remaining);
        const slice = chunk.subarray(sliceStart, sliceEnd);

        controller.enqueue(slice);
        sent += slice.length;
        skipped += chunk.length;

        if (sent >= actualLength) {
          controller.close();
          reader.cancel();
          return;
        }
      }
    },
    cancel() {
      const reader = (this as any)._reader;
      if (reader) reader.cancel();
    },
  });
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("parseRange parses 'bytes=0-499'", () => {
    const r = parseRange("bytes=0-499");
    expect(r).toEqual({ offset: 0, length: 500 });
  });

  test("parseRange parses open-ended 'bytes=100-'", () => {
    const r = parseRange("bytes=100-");
    expect(r).not.toBeNull();
    expect(r!.offset).toBe(100);
  });

  test("parseRange returns null for no header", () => {
    expect(parseRange(undefined)).toBeNull();
  });

  test("parseRange returns null for invalid header", () => {
    expect(parseRange("invalid")).toBeNull();
  });

  test("sliceStream extracts correct range", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const input = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(data); c.close(); },
    });

    const sliced = sliceStream(input, 3, 4, 10);
    const reader = sliced.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    expect(result).toEqual(new Uint8Array([3, 4, 5, 6]));
  });

  test("sliceStream works with multiple chunks", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0, 1, 2]));
        c.enqueue(new Uint8Array([3, 4, 5]));
        c.enqueue(new Uint8Array([6, 7, 8, 9]));
        c.close();
      },
    });

    const sliced = sliceStream(input, 2, 5, 10);
    const reader = sliced.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    expect(result).toEqual(new Uint8Array([2, 3, 4, 5, 6]));
  });
}
