/**
 * `uploadType=multipart` bodies: `multipart/related` with a JSON metadata part
 * and a media part. The Go client sends these only below its 16 MiB chunk
 * size, without a Content-Length, so the body is buffered up to a cap.
 */

export const MULTIPART_MAX_BYTES = 32 * 1024 * 1024;

export type RelatedParts = { metadata: Uint8Array; media: Uint8Array; mediaType: string | null };

export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/related\s*(;|$)/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2]) : null;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = haystack.indexOf(first, from); i !== -1 && i <= last; i = haystack.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (s: string) => new TextEncoder().encode(s);
const CRLF = ascii("\r\n");
const HEADER_END = ascii("\r\n\r\n");

function headersOf(block: Uint8Array): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of new TextDecoder().decode(block).split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

export function parseRelated(body: Uint8Array, boundary: string): RelatedParts | null {
  const delimiter = ascii(`--${boundary}`);
  const closing = ascii(`\r\n--${boundary}`);
  const first = indexOf(body, delimiter, 0);
  if (first === -1) return null;
  let pos = first + delimiter.length;
  const parts: { headers: Map<string, string>; content: Uint8Array }[] = [];
  while (parts.length < 2) {
    if (indexOf(body.subarray(pos, pos + 2), CRLF, 0) !== 0) return null;
    const headerEnd = indexOf(body, HEADER_END, pos);
    if (headerEnd === -1) return null;
    const contentStart = headerEnd + 4;
    const contentEnd = indexOf(body, closing, contentStart);
    if (contentEnd === -1) return null;
    parts.push({ headers: headersOf(body.subarray(pos + 2, headerEnd)), content: body.subarray(contentStart, contentEnd) });
    pos = contentEnd + closing.length;
  }
  return { metadata: parts[0].content, media: parts[1].content, mediaType: parts[1].headers.get("content-type") ?? null };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  const GO_BODY = "--b88f\r\nContent-Type: application/json\r\n\r\n{\"name\":\"a.txt\",\"crc32c\":\"Yk9x6g==\"}\n\r\n"
    + "--b88f\r\nContent-Type: text/plain\r\n\r\nsmall body\r\n--b88f--\r\n";

  test("parses the body the Go client sends", () => {
    const parts = parseRelated(ascii(GO_BODY), "b88f");
    expect(parts && text(parts.metadata)).toBe("{\"name\":\"a.txt\",\"crc32c\":\"Yk9x6g==\"}\n");
    expect(parts && text(parts.media)).toBe("small body");
    expect(parts?.mediaType).toBe("text/plain");
  });

  test("keeps a media part that contains CRLF and dashes", () => {
    const media = "line\r\n--b88 not the boundary\r\n";
    const body = `--b88f\r\nContent-Type: application/json\r\n\r\n{}\r\n--b88f\r\nContent-Type: application/octet-stream\r\n\r\n${media}\r\n--b88f--`;
    expect(text(parseRelated(ascii(body), "b88f")!.media)).toBe(media);
  });

  test.each([
    ["no boundary", "garbage"],
    ["one part", "--b88f\r\nContent-Type: application/json\r\n\r\n{}\r\n--b88f--"],
    ["unterminated", "--b88f\r\nContent-Type: application/json\r\n\r\n{}\r\n--b88f\r\n\r\nmedia"],
  ])("rejects %s", (_, body) => {
    expect(parseRelated(ascii(body), "b88f")).toBeNull();
  });

  test.each([
    ["multipart/related; boundary=abc", "abc"],
    ["multipart/related; boundary=\"a b\"", "a b"],
    ["multipart/form-data; boundary=abc", null],
    [undefined, null],
  ])("boundary of %s", (ct, want) => {
    expect(boundaryOf(ct)).toBe(want);
  });

  test("readCapped stops past the cap", async () => {
    const stream = () => new Blob([new Uint8Array(10)]).stream();
    expect((await readCapped(stream(), 10))?.length).toBe(10);
    expect(await readCapped(stream(), 9)).toBeNull();
  });
}
