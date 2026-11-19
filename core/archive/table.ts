import { createDirectoryParser, type CdRecord, type Directory } from "./zip/directory";
import { classifyName, decodeLegacy, decodeShiftJis, entryPath, normalize, RootDetector, type LegacyEncoding } from "./names";

/** How every name of one archive becomes a path. Decided once per archive, from the central directory alone. */
export interface NameRules {
  legacy: LegacyEncoding;
  rootPrefix: string;
}

export interface TableEntry {
  path: string;
  size: number;
  compressedSize: number;
  crc32: number;
  method: number;
  flags: number;
  localHeaderOffset: number;
  cdNameLength: number;
  cdExtraLength: number;
}

/**
 * Names that are neither flagged UTF-8, valid UTF-8, nor carried by a valid
 * Unicode Path extra all decode one way: Shift_JIS when every one of them is
 * strict Shift_JIS, CP437 otherwise. Deciding per archive keeps a heuristic
 * from flipping between entries. Root detection runs for both candidates in
 * the same pass, so the survey never needs a second read.
 */
export function createSurvey(filename: string) {
  let allShiftJis = true;
  const roots: Record<LegacyEncoding, RootDetector> = { shift_jis: new RootDetector(), cp437: new RootDetector() };
  return {
    observe(record: CdRecord): void {
      const name = classifyName(record.rawName, record.flags, record.unicodePath);
      if (name.kind === "utf8") {
        const normalized = normalize(name.name);
        roots.shift_jis.observe(normalized);
        roots.cp437.observe(normalized);
        return;
      }
      const shiftJis = decodeShiftJis(name.raw);
      if (shiftJis === null) allShiftJis = false;
      else roots.shift_jis.observe(normalize(shiftJis));
      roots.cp437.observe(normalize(decodeLegacy(name.raw, "cp437")));
    },
    result(): NameRules {
      const legacy: LegacyEncoding = allShiftJis ? "shift_jis" : "cp437";
      return { legacy, rootPrefix: roots[legacy].result(filename) };
    },
  };
}

export function listedPath(record: CdRecord, rules: NameRules): string | null {
  if (record.directory) return null;
  const name = classifyName(record.rawName, record.flags, record.unicodePath);
  return entryPath(normalize(name.kind === "utf8" ? name.name : decodeLegacy(name.raw, rules.legacy)), rules.rootPrefix);
}

export function toEntry(path: string, record: CdRecord): TableEntry {
  return {
    path,
    size: record.size,
    compressedSize: record.compressedSize,
    crc32: record.crc32,
    method: record.method,
    flags: record.flags,
    localHeaderOffset: record.localHeaderOffset,
    cdNameLength: record.rawName.byteLength,
    cdExtraLength: record.extraLength,
  };
}

/**
 * Fixed 48-byte little-endian records sorted by the UTF-8 bytes of the path,
 * with one name heap. UTF-8 byte order is ListObjectsV2 order, so one sort
 * serves lookup, prefix and delimiter listing, and continuation. The layout is
 * what a container index page stores byte for byte (ADR-018 §4).
 *
 *   0 u32 nameOffset    4 u16 nameLength    6 u16 method    8 u16 flags
 *  10 u16 cdNameLength 12 u32 crc32        16 f64 compressedSize
 *  24 f64 size         32 f64 localHeaderOffset (prepended data included)
 *  40 u32 cdIndex      44 u16 cdExtraLength 46 u16 reserved
 */
export interface EntryTable {
  count: number;
  records: DataView;
  names: Uint8Array;
}

const RECORD = 48;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function buildTable(cd: Uint8Array, directory: Directory, rules: NameRules): EntryTable | null {
  let records = new DataView(new ArrayBuffer(Math.max(directory.entryCount, 16) * RECORD));
  let names = new Uint8Array(Math.max(cd.byteLength, 1024));
  let count = 0;
  let heap = 0;

  const parser = createDirectoryParser(directory, (record) => {
    const path = listedPath(record, rules);
    if (path === null) return;
    const bytes = encoder.encode(path);
    if (bytes.byteLength > 0xffff) return;
    if ((count + 1) * RECORD > records.byteLength) records = grow(records);
    while (heap + bytes.byteLength > names.byteLength) names = growBytes(names);
    names.set(bytes, heap);
    writeRecord(records, count, heap, bytes.byteLength, record);
    heap += bytes.byteLength;
    count++;
  });
  if (!parser.push(cd) || parser.end() === null) return null;

  const offsets = new Uint32Array(count);
  const lengths = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = records.getUint32(i * RECORD, true);
    lengths[i] = records.getUint16(i * RECORD + 4, true);
  }
  const order = new Uint32Array(count).map((_, i) => i);
  order.sort((a, b) => compareBytes(names, offsets[a], lengths[a], names, offsets[b], lengths[b]) || a - b);

  const kept: number[] = [];
  for (let k = 0; k < order.length; k++) {
    const next = order[k + 1];
    const i = order[k];
    if (next !== undefined && compareBytes(names, offsets[i], lengths[i], names, offsets[next], lengths[next]) === 0) continue;
    kept.push(i);
  }

  const sorted = new DataView(new ArrayBuffer(kept.length * RECORD));
  const from = new Uint8Array(records.buffer);
  const to = new Uint8Array(sorted.buffer);
  kept.forEach((i, k) => to.set(from.subarray(i * RECORD, (i + 1) * RECORD), k * RECORD));
  return { count: kept.length, records: sorted, names: names.slice(0, heap) };
}

function writeRecord(records: DataView, i: number, nameOffset: number, nameLength: number, record: CdRecord): void {
  const at = i * RECORD;
  records.setUint32(at, nameOffset, true);
  records.setUint16(at + 4, nameLength, true);
  records.setUint16(at + 6, record.method, true);
  records.setUint16(at + 8, record.flags, true);
  records.setUint16(at + 10, record.rawName.byteLength, true);
  records.setUint32(at + 12, record.crc32, true);
  records.setFloat64(at + 16, record.compressedSize, true);
  records.setFloat64(at + 24, record.size, true);
  records.setFloat64(at + 32, record.localHeaderOffset, true);
  records.setUint32(at + 40, record.index, true);
  records.setUint16(at + 44, record.extraLength, true);
}

function grow(view: DataView<ArrayBuffer>): DataView<ArrayBuffer> {
  const next = new Uint8Array(view.byteLength * 2);
  next.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return new DataView(next.buffer);
}

function growBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(bytes.byteLength * 2);
  next.set(bytes);
  return next;
}

export function nameAt(table: EntryTable, i: number): Uint8Array {
  const offset = table.records.getUint32(i * RECORD, true);
  return table.names.subarray(offset, offset + table.records.getUint16(i * RECORD + 4, true));
}

export function entryAt(table: EntryTable, i: number): TableEntry {
  const at = i * RECORD;
  const r = table.records;
  return {
    path: decoder.decode(nameAt(table, i)),
    method: r.getUint16(at + 6, true),
    flags: r.getUint16(at + 8, true),
    cdNameLength: r.getUint16(at + 10, true),
    crc32: r.getUint32(at + 12, true),
    compressedSize: r.getFloat64(at + 16, true),
    size: r.getFloat64(at + 24, true),
    localHeaderOffset: r.getFloat64(at + 32, true),
    cdExtraLength: r.getUint16(at + 44, true),
  };
}

/** First index whose name is >= key (or > key when `strict`). */
export function lowerBound(table: EntryTable, key: Uint8Array, strict = false): number {
  let lo = 0;
  let hi = table.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = compare(nameAt(table, mid), key);
    if (c < 0 || (strict && c === 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function compare(a: Uint8Array, b: Uint8Array): number {
  return compareBytes(a, 0, a.byteLength, b, 0, b.byteLength);
}

function compareBytes(a: Uint8Array, aOffset: number, aLength: number, b: Uint8Array, bOffset: number, bLength: number): number {
  const n = Math.min(aLength, bLength);
  for (let i = 0; i < n; i++) {
    const d = a[aOffset + i] - b[bOffset + i];
    if (d !== 0) return d;
  }
  return aLength - bLength;
}
