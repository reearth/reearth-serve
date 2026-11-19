import type { FileStorage } from "../../asset/repository";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CD_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CD_RECORD_SIZE = 46;
const EOCD_SEARCH = 65 * 1024;
const ZIP64_EXTRA = 0x0001;
const UNICODE_PATH_EXTRA = 0x7075;
const TAIL_BYTES = 1 << 20;

export type DirectoryRefusal = "missing" | "not-zip" | "multi-disk" | "encoded-original" | "corrupt";

export interface Directory {
  offset: number;
  size: number;
  /** The low 16 bits of the entry count the end record claims, all Go's archive/zip checks. */
  recordedCount16: number;
  /** Bytes in front of the archive proper; added to every recorded offset. */
  baseOffset: number;
  etag: string | undefined;
  bytesFromTail: Uint8Array | null;
}

export interface CdRecord {
  index: number;
  rawName: Uint8Array;
  /** The Info-ZIP Unicode Path name, present only when its CRC matches `rawName`. */
  unicodePath: Uint8Array | null;
  directory: boolean;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  extraLength: number;
}

type Located = { ok: true; directory: Directory } | { ok: false; reason: DirectoryRefusal };

export async function locateDirectory(storage: FileStorage, key: string, size: number): Promise<Located> {
  if (size < EOCD_SIZE) return { ok: false, reason: "not-zip" };
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const read = await readRange(storage, key, tailStart, size - tailStart);
  if (!read.ok) return read;
  const { bytes: tail, etag } = read;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  const eocd = findEocd(view);
  if (eocd < 0) return { ok: false, reason: "not-zip" };
  let disk = view.getUint16(eocd + 4, true);
  let cdDisk = view.getUint16(eocd + 6, true);
  let recordedCount16 = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  let end = tailStart + eocd;

  const locator = eocd - ZIP64_LOCATOR_SIZE;
  if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR_SIGNATURE) {
    if (view.getUint32(locator + 16, true) > 1) return { ok: false, reason: "multi-disk" };
    const recorded = getUint64(view, locator + 8);
    const z64 = await readZip64Eocd(storage, key, tail, tailStart, recorded, tailStart + locator - ZIP64_EOCD_SIZE);
    if (!z64.ok) return z64;
    const record = z64.view;
    disk = record.getUint32(16, true);
    cdDisk = record.getUint32(20, true);
    recordedCount16 = record.getUint16(32, true);
    cdSize = getUint64(record, 40);
    cdOffset = getUint64(record, 48);
    end = z64.position;
  }
  if (disk !== 0 || cdDisk !== 0) return { ok: false, reason: "multi-disk" };

  const baseOffset = end - cdSize - cdOffset;
  if (baseOffset < 0) return { ok: false, reason: "corrupt" };
  const offset = baseOffset + cdOffset;
  const bytesFromTail = offset >= tailStart ? tail.subarray(offset - tailStart, offset - tailStart + cdSize) : null;
  return { ok: true, directory: { offset, size: cdSize, recordedCount16, baseOffset, etag, bytesFromTail } };
}

/**
 * Go's archive/zip rule, so the listing and the extractor agree on which end
 * record counts: the last signature in the final 65 KiB, and none at all when
 * that one's comment runs past the end of the file.
 */
function findEocd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_SEARCH);
  for (let i = view.byteLength - EOCD_SIZE; i >= lowest; i--) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) continue;
    return i + EOCD_SIZE + view.getUint16(i + 20, true) <= view.byteLength ? i : -1;
  }
  return -1;
}

/**
 * The locator's offset ignores prepended data, so when nothing sits at the
 * recorded offset the record is looked for right before the locator, where
 * every writer puts it.
 */
async function readZip64Eocd(
  storage: FileStorage,
  key: string,
  tail: Uint8Array,
  tailStart: number,
  recorded: number,
  adjacent: number,
): Promise<{ ok: true; view: DataView; position: number } | { ok: false; reason: DirectoryRefusal }> {
  for (const position of [recorded, adjacent]) {
    if (position < 0) continue;
    let bytes: Uint8Array;
    if (position >= tailStart && position + ZIP64_EOCD_SIZE <= tailStart + tail.byteLength) {
      bytes = tail.subarray(position - tailStart, position - tailStart + ZIP64_EOCD_SIZE);
    } else {
      const read = await readRange(storage, key, position, ZIP64_EOCD_SIZE);
      if (!read.ok) return read;
      bytes = read.bytes;
    }
    if (bytes.byteLength < ZIP64_EOCD_SIZE) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === ZIP64_EOCD_SIGNATURE) return { ok: true, view, position };
  }
  return { ok: false, reason: "corrupt" };
}

type RangeRead = { ok: true; bytes: Uint8Array; etag: string | undefined } | { ok: false; reason: DirectoryRefusal };

async function readRange(storage: FileStorage, key: string, offset: number, length: number): Promise<RangeRead> {
  const file = await storage.get(key, { offset, length });
  if (!file) return { ok: false, reason: "missing" };
  if (file.contentEncoding) {
    await file.body.cancel();
    return { ok: false, reason: "encoded-original" };
  }
  return { ok: true, bytes: await readAll(file.body, length), etag: file.etag };
}

export async function readAll(body: ReadableStream<Uint8Array>, expected: number): Promise<Uint8Array> {
  const out = new Uint8Array(expected);
  let filled = 0;
  for await (const chunk of chunks(body)) {
    if (filled + chunk.byteLength > expected) throw new Error("storage returned more bytes than requested");
    out.set(chunk, filled);
    filled += chunk.byteLength;
  }
  return filled === expected ? out : out.subarray(0, filled);
}

export async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function getUint64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000;
}

export function createDirectoryParser(directory: Directory, onRecord: (record: CdRecord) => void) {
  let carry = new Uint8Array(0);
  let consumed = 0;
  let index = 0;
  let corrupt = false;

  const parse = (buffer: Uint8Array): number => {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let at = 0;
    while (consumed < directory.size && buffer.byteLength - at >= CD_RECORD_SIZE) {
      if (view.getUint32(at, true) !== CD_SIGNATURE) {
        corrupt = true;
        return at;
      }
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const total = CD_RECORD_SIZE + nameLength + extraLength + commentLength;
      if (buffer.byteLength - at < total) break;
      onRecord(readRecord(view, buffer, at, nameLength, extraLength, index++, directory.baseOffset));
      at += total;
      consumed += total;
    }
    return at;
  };

  return {
    push(chunk: Uint8Array): boolean {
      if (corrupt) return false;
      let buffer = chunk;
      if (carry.byteLength > 0) {
        buffer = new Uint8Array(carry.byteLength + chunk.byteLength);
        buffer.set(carry);
        buffer.set(chunk, carry.byteLength);
      }
      carry = buffer.slice(parse(buffer));
      return !corrupt;
    },
    end(): number | null {
      if (corrupt || consumed !== directory.size || carry.byteLength > 0) return null;
      return index % 0x10000 === directory.recordedCount16 ? index : null;
    },
  };
}

function readRecord(
  view: DataView,
  buffer: Uint8Array,
  at: number,
  nameLength: number,
  extraLength: number,
  index: number,
  baseOffset: number,
): CdRecord {
  const madeBy = view.getUint16(at + 4, true) >> 8;
  const externalAttrs = view.getUint32(at + 38, true);
  let compressedSize = view.getUint32(at + 20, true);
  let size = view.getUint32(at + 24, true);
  let localHeaderOffset = view.getUint32(at + 42, true);
  const rawName = buffer.subarray(at + CD_RECORD_SIZE, at + CD_RECORD_SIZE + nameLength);
  let unicodePath: Uint8Array | null = null;

  let extra = at + CD_RECORD_SIZE + nameLength;
  const extraEnd = extra + extraLength;
  while (extra + 4 <= extraEnd) {
    const id = view.getUint16(extra, true);
    const length = view.getUint16(extra + 2, true);
    const body = extra + 4;
    if (body + length > extraEnd) break;
    if (id === ZIP64_EXTRA) {
      let field = body;
      const next = (): number | null => {
        if (field + 8 > body + length) return null;
        const value = getUint64(view, field);
        field += 8;
        return value;
      };
      if (size === 0xffffffff) size = next() ?? size;
      if (compressedSize === 0xffffffff) compressedSize = next() ?? compressedSize;
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = next() ?? localHeaderOffset;
    } else if (id === UNICODE_PATH_EXTRA && length >= 5 && view.getUint8(body) === 1) {
      if (view.getUint32(body + 1, true) === crc32(rawName)) unicodePath = buffer.subarray(body + 5, body + length);
    }
    extra = body + length;
  }

  return {
    index,
    rawName,
    unicodePath,
    directory: isDirectory(rawName, madeBy, externalAttrs),
    flags: view.getUint16(at + 8, true),
    method: view.getUint16(at + 10, true),
    crc32: view.getUint32(at + 16, true),
    compressedSize,
    size,
    localHeaderOffset: localHeaderOffset + baseOffset,
    extraLength,
  };
}

const CREATOR_FAT = 0;
const CREATOR_UNIX = 3;
const CREATOR_NTFS = 11;
const CREATOR_VFAT = 14;
const CREATOR_MACOS = 19;

/** Go's zip.FileHeader.Mode().IsDir(), which the extractor uses to skip entries. */
function isDirectory(rawName: Uint8Array, madeBy: number, externalAttrs: number): boolean {
  if (rawName[rawName.byteLength - 1] === 0x2f) return true;
  if (madeBy === CREATOR_UNIX || madeBy === CREATOR_MACOS) return ((externalAttrs >>> 16) & 0xf000) === 0x4000;
  if (madeBy === CREATOR_FAT || madeBy === CREATOR_NTFS || madeBy === CREATOR_VFAT) return (externalAttrs & 0x10) !== 0;
  return false;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
