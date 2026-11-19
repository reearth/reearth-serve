import { crc32, createDirectoryParser, type CdRecord, type Directory } from "./zip/directory";
import { classifyName, decodeLegacy, decodeShiftJis, entryPath, normalize, RootDetector, type LegacyEncoding } from "./names";

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
  cdNameCrc: number;
}

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
    cdNameCrc: crc32(record.rawName),
  };
}

export interface EntryTable {
  count: number;
  records: DataView;
  names: Uint8Array;
}

export const RECORD = 52;
const CD_RECORD_SIZE = 46;
const NAME_OFFSET = 0;
const CD_EXTRA_LENGTH = 4;
const METHOD = 6;
const FLAGS = 8;
const CD_NAME_LENGTH = 10;
const CRC32 = 12;
const COMPRESSED_SIZE = 16;
const SIZE = 24;
const LOCAL_HEADER_OFFSET = 32;
const CD_INDEX = 40;
const NAME_LENGTH = 44;
const CD_NAME_CRC = 48;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BuiltTable {
  table: EntryTable;
  directoryRecordCount: number;
}

export function buildTable(cd: Uint8Array, directory: Directory, rules: NameRules): BuiltTable | null {
  const records = new DataView(new ArrayBuffer(Math.floor(cd.byteLength / CD_RECORD_SIZE) * RECORD));
  let names = new Uint8Array(Math.max(cd.byteLength, 1024));
  let count = 0;
  let heap = 0;

  const parser = createDirectoryParser(directory, (record) => {
    const path = listedPath(record, rules);
    if (path === null) return;
    const bytes = encoder.encode(path);
    while (heap + bytes.byteLength > names.byteLength) names = growBytes(names);
    names.set(bytes, heap);
    writeRecord(records, count, heap, bytes.byteLength, record);
    heap += bytes.byteLength;
    count++;
  });
  const directoryRecordCount = parser.push(cd) ? parser.end() : null;
  if (directoryRecordCount === null) return null;

  const offsets = new Uint32Array(count);
  const lengths = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i] = records.getUint32(i * RECORD + NAME_OFFSET, true);
    lengths[i] = records.getUint32(i * RECORD + NAME_LENGTH, true);
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
  return { table: { count: kept.length, records: sorted, names: names.slice(0, heap) }, directoryRecordCount };
}

function writeRecord(records: DataView, i: number, nameOffset: number, nameLength: number, record: CdRecord): void {
  const at = i * RECORD;
  records.setUint32(at + NAME_OFFSET, nameOffset, true);
  records.setUint32(at + NAME_LENGTH, nameLength, true);
  records.setUint16(at + METHOD, record.method, true);
  records.setUint16(at + FLAGS, record.flags, true);
  records.setUint16(at + CD_NAME_LENGTH, record.rawName.byteLength, true);
  records.setUint32(at + CRC32, record.crc32, true);
  records.setFloat64(at + COMPRESSED_SIZE, record.compressedSize, true);
  records.setFloat64(at + SIZE, record.size, true);
  records.setFloat64(at + LOCAL_HEADER_OFFSET, record.localHeaderOffset, true);
  records.setUint32(at + CD_INDEX, record.index, true);
  records.setUint16(at + CD_EXTRA_LENGTH, record.extraLength, true);
  records.setUint32(at + CD_NAME_CRC, crc32(record.rawName), true);
}

function growBytes(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(bytes.byteLength * 2);
  next.set(bytes);
  return next;
}

/** Records `start` to `end` with their names copied into a heap of their own, offsets rebased to it. */
export function sliceTable(table: EntryTable, start: number, end: number): EntryTable {
  const count = end - start;
  const records = new DataView(table.records.buffer.slice(table.records.byteOffset + start * RECORD, table.records.byteOffset + end * RECORD));
  let heap = 0;
  for (let i = start; i < end; i++) heap += table.records.getUint32(i * RECORD + NAME_LENGTH, true);
  const names = new Uint8Array(heap);
  let at = 0;
  for (let k = 0; k < count; k++) {
    const name = nameAt(table, start + k);
    names.set(name, at);
    records.setUint32(k * RECORD + NAME_OFFSET, at, true);
    at += name.byteLength;
  }
  return { count, records, names };
}

export function nameAt(table: EntryTable, i: number): Uint8Array {
  const at = i * RECORD;
  const offset = table.records.getUint32(at + NAME_OFFSET, true);
  return table.names.subarray(offset, offset + table.records.getUint32(at + NAME_LENGTH, true));
}

export function entryAt(table: EntryTable, i: number): TableEntry {
  const at = i * RECORD;
  const r = table.records;
  return {
    path: decoder.decode(nameAt(table, i)),
    method: r.getUint16(at + METHOD, true),
    flags: r.getUint16(at + FLAGS, true),
    cdNameLength: r.getUint16(at + CD_NAME_LENGTH, true),
    crc32: r.getUint32(at + CRC32, true),
    compressedSize: r.getFloat64(at + COMPRESSED_SIZE, true),
    size: r.getFloat64(at + SIZE, true),
    localHeaderOffset: r.getFloat64(at + LOCAL_HEADER_OFFSET, true),
    cdExtraLength: r.getUint16(at + CD_EXTRA_LENGTH, true),
    cdNameCrc: r.getUint32(at + CD_NAME_CRC, true),
  };
}

export function lowerBound(table: EntryTable, key: Uint8Array): number {
  return firstIndex(table, (name) => compare(name, key) >= 0);
}

export function upperBound(table: EntryTable, key: Uint8Array): number {
  return firstIndex(table, (name) => compare(name, key) > 0);
}

function firstIndex(table: EntryTable, reached: (name: Uint8Array) => boolean): number {
  let lo = 0;
  let hi = table.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (reached(nameAt(table, mid))) hi = mid;
    else lo = mid + 1;
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
