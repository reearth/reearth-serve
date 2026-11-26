/** One `bytes` range as sent, before the representation's size is known (RFC 9110 §14.1.2). */
export type RangeRequest =
  | { kind: "from"; first: number; last: number | null }
  | { kind: "suffix"; length: number };

/** What a range means against a representation of a known size. */
export type ResolvedRange =
  | { kind: "whole" }
  | { kind: "part"; offset: number; length: number }
  | { kind: "unsatisfiable" };

/**
 * A single `bytes` range, or null when there is none to honor: no header, a
 * malformed or inverted range, another unit, or several ranges, each of which
 * RFC 9110 §14.2 lets a server ignore.
 */
export function parseRange(header: string | undefined): RangeRequest | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const [, first, last] = match;
  if (first === "") return last === "" ? null : { kind: "suffix", length: Number(last) };
  if (last !== "" && Number(last) < Number(first)) return null;
  return { kind: "from", first: Number(first), last: last === "" ? null : Number(last) };
}

export function resolveRange(range: RangeRequest | null, size: number): ResolvedRange {
  if (!range) return { kind: "whole" };
  if (range.kind === "suffix") {
    if (range.length === 0 || size === 0) return { kind: "unsatisfiable" };
    const length = Math.min(range.length, size);
    return { kind: "part", offset: size - length, length };
  }
  if (range.first >= size) return { kind: "unsatisfiable" };
  const last = Math.min(range.last ?? size - 1, size - 1);
  return { kind: "part", offset: range.first, length: last - range.first + 1 };
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

  test.each([
    ["bytes=0-499", { kind: "from", first: 0, last: 499 }],
    ["bytes=100-", { kind: "from", first: 100, last: null }],
    ["bytes=-5", { kind: "suffix", length: 5 }],
    ["Bytes=3-3", { kind: "from", first: 3, last: 3 }],
    ["bytes=5-2", null],
    ["bytes=0-1,4-5", null],
    ["items=0-4", null],
    ["bytes=-", null],
    ["invalid", null],
    [undefined, null],
  ] as const)("parseRange(%s)", (header, parsed) => {
    expect(parseRange(header)).toEqual(parsed);
  });

  test.each([
    [null, 10, { kind: "whole" }],
    [{ kind: "from", first: 2, last: 4 }, 10, { kind: "part", offset: 2, length: 3 }],
    [{ kind: "from", first: 2, last: 40 }, 10, { kind: "part", offset: 2, length: 8 }],
    [{ kind: "from", first: 10, last: null }, 10, { kind: "unsatisfiable" }],
    [{ kind: "suffix", length: 3 }, 10, { kind: "part", offset: 7, length: 3 }],
    [{ kind: "suffix", length: 30 }, 10, { kind: "part", offset: 0, length: 10 }],
    [{ kind: "suffix", length: 0 }, 10, { kind: "unsatisfiable" }],
    [{ kind: "from", first: 0, last: 0 }, 0, { kind: "unsatisfiable" }],
    [{ kind: "suffix", length: 1 }, 0, { kind: "unsatisfiable" }],
  ] as const)("resolveRange(%o, %d)", (range, size, resolved) => {
    expect(resolveRange(range, size)).toEqual(resolved);
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
