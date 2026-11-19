import type { ExactHashes } from "./model";

export type Md5State = { h: [number, number, number, number]; tail: string; length: number };
export type HashState = { md5: Md5State; crc32c: number };

export const initialHashState: HashState = {
  md5: { h: [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476], tail: "", length: 0 },
  crc32c: 0,
};

const CRC_TABLES = (() => {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

function crc32cUpdate(crc: number, b: Uint8Array): number {
  const t = CRC_TABLES;
  let c = ~crc;
  let i = 0;
  const n = b.length;
  for (; i + 8 <= n; i += 8) {
    const lo = c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    const hi = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    c = t[1792 + (lo & 0xff)] ^ t[1536 + ((lo >>> 8) & 0xff)] ^ t[1280 + ((lo >>> 16) & 0xff)] ^ t[1024 + (lo >>> 24)]
      ^ t[768 + (hi & 0xff)] ^ t[512 + ((hi >>> 8) & 0xff)] ^ t[256 + ((hi >>> 16) & 0xff)] ^ t[hi >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
const MD5_S = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);
const MD5_G = Uint8Array.from({ length: 64 }, (_, i) =>
  i < 16 ? i : i < 32 ? (5 * i + 1) & 15 : i < 48 ? (3 * i + 5) & 15 : (7 * i) & 15);

function md5Block(h: Int32Array, b: Uint8Array, o: number, w: Int32Array): void {
  for (let j = 0; j < 16; j++, o += 4) w[j] = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  let a = h[0], bb = h[1], c = h[2], d = h[3];
  for (let i = 0; i < 64; i++) {
    const f = i < 16 ? (bb & c) | (~bb & d)
      : i < 32 ? (d & bb) | (~d & c)
        : i < 48 ? bb ^ c ^ d
          : c ^ (bb | ~d);
    const x = (a + f + MD5_K[i] + w[MD5_G[i]]) | 0;
    const s = MD5_S[i];
    a = d;
    d = c;
    c = bb;
    bb = (bb + ((x << s) | (x >>> (32 - s)))) | 0;
  }
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + bb) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0;
}

export function base64Of(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

export type Hasher = {
  update(bytes: Uint8Array): void;
  state(): HashState;
  digest(): ExactHashes;
};

export function createHasher(from: HashState = initialHashState): Hasher {
  const h = Int32Array.from(from.md5.h);
  const w = new Int32Array(16);
  const buf = new Uint8Array(64);
  const tail = fromBase64(from.md5.tail);
  buf.set(tail);
  let buffered = tail.length;
  let length = from.md5.length;
  let crc = from.crc32c;

  function update(bytes: Uint8Array): void {
    crc = crc32cUpdate(crc, bytes);
    length += bytes.length;
    let i = 0;
    if (buffered > 0) {
      const take = Math.min(64 - buffered, bytes.length);
      buf.set(bytes.subarray(0, take), buffered);
      buffered += take;
      i = take;
      if (buffered < 64) return;
      md5Block(h, buf, 0, w);
      buffered = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) md5Block(h, bytes, i, w);
    buf.set(bytes.subarray(i), 0);
    buffered = bytes.length - i;
  }

  function state(): HashState {
    return {
      md5: { h: [h[0], h[1], h[2], h[3]], tail: base64Of(buf.subarray(0, buffered)), length },
      crc32c: crc,
    };
  }

  function digest(): ExactHashes {
    const fin = Int32Array.from(h);
    const pad = new Uint8Array(buffered < 56 ? 64 : 128);
    pad.set(buf.subarray(0, buffered));
    pad[buffered] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, (length * 8) >>> 0, true);
    view.setUint32(pad.length - 4, Math.floor(length / 0x20000000), true);
    for (let o = 0; o < pad.length; o += 64) md5Block(fin, pad, o, w);
    const md5 = new Uint8Array(16);
    const out = new DataView(md5.buffer);
    for (let j = 0; j < 4; j++) out.setInt32(j * 4, fin[j], true);
    return { md5, crc32c: crc };
  }

  return { update, state, digest };
}

export type HashingStream = {
  stream: ReadableStream<Uint8Array>;
  /** Resolves once every input byte has passed through the stream. */
  state(): Promise<HashState>;
  digest(): Promise<ExactHashes>;
};

export function hashingStream(input: ReadableStream<Uint8Array>, from?: HashState): HashingStream {
  const hasher = createHasher(from);
  let done!: () => void;
  const drained = new Promise<void>((resolve) => { done = resolve; });
  const stream = input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      done();
    },
  }));
  return {
    stream,
    state: () => drained.then(() => hasher.state()),
    digest: () => drained.then(() => hasher.digest()),
  };
}

/** GCS renders `crc32c` as the base64 of its four big-endian bytes. */
export function crc32cBase64(crc: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, crc >>> 0, false);
  return base64Of(bytes);
}
