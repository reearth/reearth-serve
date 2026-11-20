import { describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createHasher, crc32cBase64, hashingStream, type HashState } from "./hash";

const ascii = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function oneShot(bytes: Uint8Array) {
  const h = createHasher();
  h.update(bytes);
  return h.digest();
}

describe("CRC32C", () => {
  test.each([
    ["123456789", ascii("123456789"), 0xe3069283],
    ["32 zero bytes (RFC 3720 B.4)", new Uint8Array(32), 0x8a9136aa],
    ["32 0xFF bytes (RFC 3720 B.4)", new Uint8Array(32).fill(0xff), 0x62a8ab43],
    ["0..31 (RFC 3720 B.4)", Uint8Array.from({ length: 32 }, (_, i) => i), 0x46dd794e],
    ["31..0 (RFC 3720 B.4)", Uint8Array.from({ length: 32 }, (_, i) => 31 - i), 0x113fdb5c],
    ["empty", new Uint8Array(0), 0],
  ])("%s", (_, bytes, want) => {
    expect(oneShot(bytes).crc32c).toBe(want);
  });

  test("renders as GCS does: base64 of the big-endian bytes", () => {
    expect(crc32cBase64(0xe3069283)).toBe("4waSgw==");
  });
});

describe("MD5 (RFC 1321 A.5)", () => {
  test.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
  ])("%j", (input, want) => {
    expect(hex(oneShot(ascii(input)).md5)).toBe(want);
  });

  test.each([55, 56, 63, 64, 65, 119, 120, 128, 100_003])("agrees with node:crypto at %i bytes", (n) => {
    const bytes = randomBytes(n);
    expect(hex(oneShot(bytes).md5)).toBe(createHash("md5").update(bytes).digest("hex"));
  });
});

describe("split state", () => {
  const bytes = new Uint8Array(randomBytes(10_000));
  const whole = oneShot(bytes);

  test.each([[1], [63], [64], [65], [4097], [9_999]])("hashing in %i-byte chunks equals hashing at once", (size) => {
    const h = createHasher();
    for (let i = 0; i < bytes.length; i += size) h.update(bytes.subarray(i, i + size));
    expect(h.digest()).toEqual(whole);
  });

  test("a state that went through JSON resumes to the same digest", () => {
    let state: HashState | undefined;
    for (const [from, to] of [[0, 1000], [1000, 1037], [1037, 7777], [7777, 10_000]]) {
      const h = createHasher(state);
      h.update(bytes.subarray(from, to));
      state = JSON.parse(JSON.stringify(h.state())) as HashState;
    }
    expect(createHasher(state).digest()).toEqual(whole);
  });

  test("hashingStream passes the bytes through and digests them once drained", async () => {
    const chunks = [bytes.subarray(0, 3000), bytes.subarray(3000)];
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const hashed = hashingStream(input);
    const out = new Uint8Array(await new Response(hashed.stream).arrayBuffer());
    expect(out).toEqual(bytes);
    expect(await hashed.digest()).toEqual(whole);
  });
});
