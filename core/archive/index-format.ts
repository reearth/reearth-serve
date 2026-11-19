import type { LegacyEncoding } from "./names";
import { nameAt, RECORD, sliceTable, type EntryTable, type NameRules } from "./table";
import { crc32, type Directory } from "./zip/directory";

/**
 * Container index v1 (`SRVCIDX1`), one immutable object:
 *
 *   [header, 128 B][root prefix][fence][page 0][page 1]...
 *
 * The fence holds one fixed record per page (offset, length, CRC-32, first
 * name length) followed by every page's first name. A page is up to 256
 * records in the table's record layout, name offsets relative to the page's
 * own name heap, followed by that heap. The fence CRC covers the root prefix
 * and the fence. The encoding is a pure function of its inputs.
 */
export const INDEX_HEAD_BYTES = 64 * 1024;
export const PAGE_ENTRIES = 256;

const MAGIC = new TextEncoder().encode("SRVCIDX1");
const VERSION = 1;
const FORMAT_ZIP = 1;
const HEADER = 128;
const FENCE_RECORD = 20;
const ETAG_AT = 80;
const MAX_ETAG = 44;
const HEADER_CRC = 124;

const H_VERSION = 8;
const H_FORMAT = 10;
const H_LEGACY = 11;
const H_PAGE_ENTRIES = 12;
const H_ROOT_LENGTH = 14;
const H_COUNT = 16;
const H_PAGE_COUNT = 20;
const H_CD_ENTRIES = 24;
const H_SOURCE_SIZE = 32;
const H_CD_OFFSET = 40;
const H_CD_SIZE = 48;
const H_BASE_OFFSET = 56;
const H_FENCE_END = 64;
const H_FENCE_CRC = 72;
const H_ETAG_LENGTH = 76;

const LEGACY: LegacyEncoding[] = ["cp437", "shift_jis"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface IndexInputs {
  table: EntryTable;
  rules: NameRules;
  directory: Directory;
  directoryRecordCount: number;
  sourceSize: number;
}

export interface IndexHeader {
  legacy: LegacyEncoding;
  count: number;
  directoryRecordCount: number;
  pageEntries: number;
  pageCount: number;
  sourceSize: number;
  sourceEtag: string | undefined;
  directory: { offset: number; size: number };
  baseOffset: number;
  rootPrefixLength: number;
  fenceEnd: number;
  fenceCrc: number;
}

export interface PageRef {
  offset: number;
  length: number;
  crc32: number;
  count: number;
  firstName: Uint8Array;
}

export interface IndexFence {
  header: IndexHeader;
  rootPrefix: string;
  pages: PageRef[];
}

export type IndexRejection = "truncated" | "magic" | "version" | "format" | "header-crc" | "fence-crc" | "size" | "etag";

export function encodeIndex({ table, rules, directory, directoryRecordCount, sourceSize }: IndexInputs): Uint8Array | null {
  const etag = encoder.encode(directory.etag ?? "");
  const root = encoder.encode(rules.rootPrefix);
  if (etag.byteLength > MAX_ETAG || root.byteLength > 0xffff) return null;

  const pages: Uint8Array[] = [];
  const firsts: Uint8Array[] = [];
  for (let start = 0; start < table.count; start += PAGE_ENTRIES) {
    const page = sliceTable(table, start, Math.min(start + PAGE_ENTRIES, table.count));
    const bytes = new Uint8Array(page.records.byteLength + page.names.byteLength);
    bytes.set(new Uint8Array(page.records.buffer, page.records.byteOffset, page.records.byteLength));
    bytes.set(page.names, page.records.byteLength);
    pages.push(bytes);
    firsts.push(nameAt(table, start));
  }

  const fenceStart = HEADER + root.byteLength;
  const namesStart = fenceStart + pages.length * FENCE_RECORD;
  const fenceEnd = namesStart + sum(firsts);
  const out = new Uint8Array(fenceEnd + sum(pages));
  const view = new DataView(out.buffer);

  out.set(root, HEADER);
  let pageAt = fenceEnd;
  let nameAtFence = namesStart;
  pages.forEach((page, p) => {
    const at = fenceStart + p * FENCE_RECORD;
    view.setFloat64(at, pageAt, true);
    view.setUint32(at + 8, page.byteLength, true);
    view.setUint32(at + 12, crc32(page), true);
    view.setUint32(at + 16, firsts[p].byteLength, true);
    out.set(page, pageAt);
    out.set(firsts[p], nameAtFence);
    pageAt += page.byteLength;
    nameAtFence += firsts[p].byteLength;
  });

  out.set(MAGIC, 0);
  view.setUint16(H_VERSION, VERSION, true);
  view.setUint8(H_FORMAT, FORMAT_ZIP);
  view.setUint8(H_LEGACY, LEGACY.indexOf(rules.legacy));
  view.setUint16(H_PAGE_ENTRIES, PAGE_ENTRIES, true);
  view.setUint16(H_ROOT_LENGTH, root.byteLength, true);
  view.setUint32(H_COUNT, table.count, true);
  view.setUint32(H_PAGE_COUNT, pages.length, true);
  view.setFloat64(H_CD_ENTRIES, directoryRecordCount, true);
  view.setFloat64(H_SOURCE_SIZE, sourceSize, true);
  view.setFloat64(H_CD_OFFSET, directory.offset, true);
  view.setFloat64(H_CD_SIZE, directory.size, true);
  view.setFloat64(H_BASE_OFFSET, directory.baseOffset, true);
  view.setFloat64(H_FENCE_END, fenceEnd, true);
  view.setUint32(H_FENCE_CRC, crc32(out.subarray(HEADER, fenceEnd)), true);
  view.setUint8(H_ETAG_LENGTH, etag.byteLength);
  out.set(etag, ETAG_AT);
  view.setUint32(HEADER_CRC, crc32(out.subarray(0, HEADER_CRC)), true);
  return out;
}

export function readHeader(bytes: Uint8Array, expect: { size: number; etag?: string }): { ok: true; header: IndexHeader } | { ok: false; reason: IndexRejection } {
  if (bytes.byteLength < HEADER) return { ok: false, reason: "truncated" };
  if (MAGIC.some((b, i) => bytes[i] !== b)) return { ok: false, reason: "magic" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER);
  if (view.getUint16(H_VERSION, true) !== VERSION) return { ok: false, reason: "version" };
  if (view.getUint32(HEADER_CRC, true) !== crc32(bytes.subarray(0, HEADER_CRC))) return { ok: false, reason: "header-crc" };
  const legacy = LEGACY[view.getUint8(H_LEGACY)];
  const pageEntries = view.getUint16(H_PAGE_ENTRIES, true);
  if (view.getUint8(H_FORMAT) !== FORMAT_ZIP || !legacy || pageEntries === 0) return { ok: false, reason: "format" };

  const etagLength = Math.min(view.getUint8(H_ETAG_LENGTH), MAX_ETAG);
  const header: IndexHeader = {
    legacy,
    count: view.getUint32(H_COUNT, true),
    directoryRecordCount: view.getFloat64(H_CD_ENTRIES, true),
    pageEntries,
    pageCount: view.getUint32(H_PAGE_COUNT, true),
    sourceSize: view.getFloat64(H_SOURCE_SIZE, true),
    sourceEtag: etagLength > 0 ? decoder.decode(bytes.subarray(ETAG_AT, ETAG_AT + etagLength)) : undefined,
    directory: { offset: view.getFloat64(H_CD_OFFSET, true), size: view.getFloat64(H_CD_SIZE, true) },
    baseOffset: view.getFloat64(H_BASE_OFFSET, true),
    rootPrefixLength: view.getUint16(H_ROOT_LENGTH, true),
    fenceEnd: view.getFloat64(H_FENCE_END, true),
    fenceCrc: view.getUint32(H_FENCE_CRC, true),
  };
  if (header.pageCount !== Math.ceil(header.count / pageEntries)) return { ok: false, reason: "format" };
  if (!Number.isSafeInteger(header.fenceEnd) || header.fenceEnd < HEADER + header.rootPrefixLength + header.pageCount * FENCE_RECORD) {
    return { ok: false, reason: "format" };
  }
  if (header.sourceSize !== expect.size) return { ok: false, reason: "size" };
  if (expect.etag !== undefined && header.sourceEtag !== undefined && header.sourceEtag !== expect.etag) return { ok: false, reason: "etag" };
  return { ok: true, header };
}

export function readFence(bytes: Uint8Array, header: IndexHeader): { ok: true; fence: IndexFence } | { ok: false; reason: IndexRejection } {
  if (bytes.byteLength < header.fenceEnd) return { ok: false, reason: "truncated" };
  if (crc32(bytes.subarray(HEADER, header.fenceEnd)) !== header.fenceCrc) return { ok: false, reason: "fence-crc" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, header.fenceEnd);
  const fenceStart = HEADER + header.rootPrefixLength;
  let nameCursor = fenceStart + header.pageCount * FENCE_RECORD;
  const pages: PageRef[] = [];
  for (let p = 0; p < header.pageCount; p++) {
    const at = fenceStart + p * FENCE_RECORD;
    const firstLength = view.getUint32(at + 16, true);
    if (nameCursor + firstLength > header.fenceEnd) return { ok: false, reason: "format" };
    pages.push({
      offset: view.getFloat64(at, true),
      length: view.getUint32(at + 8, true),
      crc32: view.getUint32(at + 12, true),
      count: Math.min(header.pageEntries, header.count - p * header.pageEntries),
      firstName: bytes.slice(nameCursor, nameCursor + firstLength),
    });
    nameCursor += firstLength;
  }
  if (nameCursor !== header.fenceEnd) return { ok: false, reason: "format" };
  const rootPrefix = decoder.decode(bytes.subarray(HEADER, fenceStart));
  return { ok: true, fence: { header, rootPrefix, pages } };
}

export function readPage(bytes: Uint8Array, page: PageRef): EntryTable | null {
  const records = page.count * RECORD;
  if (bytes.byteLength !== page.length || records > bytes.byteLength || crc32(bytes) !== page.crc32) return null;
  return { count: page.count, records: new DataView(bytes.buffer, bytes.byteOffset, records), names: bytes.subarray(records) };
}

function sum(parts: Uint8Array[]): number {
  return parts.reduce((total, part) => total + part.byteLength, 0);
}
