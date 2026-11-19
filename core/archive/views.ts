import type { FileStorage } from "../asset/repository";
import { INDEX_HEAD_BYTES, readFence, readHeader, readPage, type IndexFence, type IndexRejection } from "./index-format";
import { chunks, createDirectoryParser, readAll, type CdRecord, type Directory } from "./zip/directory";
import { compare, entryAt, lowerBound, upperBound, listedPath, nameAt, toEntry, type EntryTable, type NameRules, type TableEntry } from "./table";

export interface ListQuery {
  prefix: string;
  delimiter: string;
  after: string;
  limit: number;
}

export interface ListResult {
  entries: TableEntry[];
  commonPrefixes: string[];
  next?: string;
}

/**
 * What both views answer, identically. A listing is in UTF-8 byte order with
 * S3 ListObjectsV2 semantics: `after` is exclusive, a common prefix equal to
 * `after` was already returned, and `next` is the last key or common prefix
 * of a page when more remain.
 */
export interface TableView {
  readonly entryCount: number;
  readonly etag: string | undefined;
  readonly rootPrefix: string;
  /** "index" when answers come from a container index, which may be distrusted and replaced by the central directory. */
  readonly from: "directory" | "index";
  find(path: string): Promise<TableEntry | null>;
  list(query: ListQuery): Promise<ListResult>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A byte-sorted run of unique entry names, reached one table at a time:
 * MemoryView holds one table, IndexedView one page per table. Both views
 * find and list through it, so they cannot answer differently.
 */
interface SortedEntries {
  readonly count: number;
  /** The table holding position `i`, and the position of that table's first record. */
  chunk(i: number): Promise<{ table: EntryTable; start: number }>;
  lowerBound(key: Uint8Array): Promise<number>;
  upperBound(key: Uint8Array): Promise<number>;
}

function sortedView(sorted: SortedEntries, fields: Pick<TableView, "entryCount" | "etag" | "rootPrefix" | "from">): TableView {
  return { ...fields, find: (path) => findIn(sorted, path), list: (query) => listIn(sorted, query) };
}

async function findIn(sorted: SortedEntries, path: string): Promise<TableEntry | null> {
  const key = encoder.encode(path);
  const i = await sorted.lowerBound(key);
  if (i >= sorted.count) return null;
  const { table, start } = await sorted.chunk(i);
  return compare(nameAt(table, i - start), key) === 0 ? entryAt(table, i - start) : null;
}

async function listIn(sorted: SortedEntries, query: ListQuery): Promise<ListResult> {
  const prefix = encoder.encode(query.prefix);
  const delimiter = encoder.encode(query.delimiter);
  const result: ListResult = { entries: [], commonPrefixes: [] };
  let i = await sorted.lowerBound(prefix);
  if (query.after) i = Math.max(i, await sorted.upperBound(encoder.encode(query.after)));
  let last = "";
  while (i < sorted.count) {
    const { table, start } = await sorted.chunk(i);
    const name = nameAt(table, i - start);
    if (!startsWith(name, prefix)) break;
    const split = delimiter.byteLength > 0 ? indexOf(name, delimiter, prefix.byteLength) : -1;
    const common = split >= 0 ? name.subarray(0, split + delimiter.byteLength) : null;
    if (common) {
      i = await sorted.lowerBound(successor(common));
      const value = decoder.decode(common);
      if (value === query.after) continue;
      if (result.entries.length + result.commonPrefixes.length === query.limit) return { ...result, next: last };
      result.commonPrefixes.push(value);
      last = value;
      continue;
    }
    if (result.entries.length + result.commonPrefixes.length === query.limit) return { ...result, next: last };
    const entry = entryAt(table, i++ - start);
    result.entries.push(entry);
    last = entry.path;
  }
  return result;
}

export function memoryView(table: EntryTable, entryCount: number, rootPrefix: string, etag: string | undefined): TableView {
  const whole = { table, start: 0 };
  return sortedView(
    {
      count: table.count,
      chunk: async () => whole,
      lowerBound: async (key) => lowerBound(table, key),
      upperBound: async (key) => upperBound(table, key),
    },
    { entryCount, etag, rootPrefix, from: "directory" },
  );
}

const PAGE_BUDGET = 2 * 1024 * 1024;

/** An IndexedView page that cannot be read or fails its CRC-32. The reader distrusts the index and answers from the central directory. */
export class IndexUnusable extends Error {}

export type IndexedOpen = { ok: true; view: TableView; bytes: number } | { ok: false; reason: IndexRejection | "missing" | "unreadable" };

/** One read of the index head, and a second only when the fence runs past it. Pages are read on demand and held up to `pageBudget` bytes. */
export async function openIndexedView(storage: FileStorage, key: string, sourceSize: number, pageBudget = PAGE_BUDGET): Promise<IndexedOpen> {
  let opened: Awaited<ReturnType<typeof readIndexHead>>;
  try {
    opened = await readIndexHead(storage, key, sourceSize);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!opened.ok) return opened;
  return { ok: true, view: indexedView(storage, key, opened.fence, pageBudget), bytes: opened.fence.header.fenceEnd + pageBudget };
}

async function readIndexHead(storage: FileStorage, key: string, sourceSize: number): Promise<{ ok: true; fence: IndexFence } | { ok: false; reason: IndexRejection | "missing" }> {
  const first = await readObject(storage, key, 0, INDEX_HEAD_BYTES);
  if (!first) return { ok: false, reason: "missing" };
  const head = readHeader(first, { size: sourceSize });
  if (!head.ok) return head;
  const { fenceEnd } = head.header;
  if (fenceEnd <= first.byteLength) return readFence(first, head.header);
  if (first.byteLength < INDEX_HEAD_BYTES) return { ok: false, reason: "truncated" };
  const rest = await readObject(storage, key, first.byteLength, fenceEnd - first.byteLength);
  if (!rest) return { ok: false, reason: "missing" };
  const bytes = new Uint8Array(first.byteLength + rest.byteLength);
  bytes.set(first);
  bytes.set(rest, first.byteLength);
  return readFence(bytes, head.header);
}

async function readObject(storage: FileStorage, key: string, offset: number, length: number): Promise<Uint8Array | null> {
  const file = await storage.get(key, { offset, length });
  return file && readAll(file.body, length);
}

function indexedView(storage: FileStorage, key: string, fence: IndexFence, pageBudget: number): TableView {
  const { header, pages } = fence;
  const loaded = new Map<number, Promise<EntryTable>>();
  let held = 0;

  const forget = (p: number) => {
    if (loaded.delete(p)) held -= pages[p].length;
  };
  const load = async (p: number): Promise<EntryTable> => {
    let bytes: Uint8Array | null;
    try {
      bytes = await readObject(storage, key, pages[p].offset, pages[p].length);
    } catch (e) {
      throw new IndexUnusable(`index ${key} page ${p} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!bytes) throw new IndexUnusable(`index ${key} is missing`);
    const table = readPage(bytes, pages[p]);
    if (!table) throw new IndexUnusable(`index ${key} page ${p} fails its CRC-32`);
    return table;
  };
  const page = (p: number): Promise<EntryTable> => {
    const hit = loaded.get(p);
    if (hit) {
      loaded.delete(p);
      loaded.set(p, hit);
      return hit;
    }
    const loading = load(p);
    loaded.set(p, loading);
    held += pages[p].length;
    loading.catch(() => {
      if (loaded.get(p) === loading) forget(p);
    });
    for (const oldest of loaded.keys()) {
      if (held <= pageBudget || oldest === p) break;
      forget(oldest);
    }
    return loading;
  };
  const pageOf = (key: Uint8Array): number => {
    let lo = 0;
    let hi = pages.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(pages[mid].firstName, key) > 0) hi = mid;
      else lo = mid + 1;
    }
    return Math.max(0, lo - 1);
  };
  const bound = (search: (table: EntryTable, key: Uint8Array) => number) => async (key: Uint8Array) => {
    if (pages.length === 0) return 0;
    const p = pageOf(key);
    return p * header.pageEntries + search(await page(p), key);
  };

  return sortedView(
    {
      count: header.count,
      chunk: async (i) => {
        const p = Math.floor(i / header.pageEntries);
        return { table: await page(p), start: p * header.pageEntries };
      },
      lowerBound: bound(lowerBound),
      upperBound: bound(upperBound),
    },
    { entryCount: header.directoryRecordCount, etag: header.sourceEtag, rootPrefix: fence.rootPrefix, from: "index" },
  );
}

export function scanView(
  storage: FileStorage,
  key: string,
  directory: Directory,
  rules: NameRules,
  entryCount: number,
  onStale: () => void,
): TableView {
  const pass = async (visit: (path: string, record: CdRecord) => void): Promise<void> => {
    const file = await storage.get(key, { offset: directory.offset, length: directory.size });
    if (!file || (directory.etag && file.etag && file.etag !== directory.etag)) {
      await file?.body.cancel();
      onStale();
      throw new Error(`archive ${key} changed after its central directory was read`);
    }
    const parser = createDirectoryParser(directory, (record) => {
      const path = listedPath(record, rules);
      if (path !== null) visit(path, record);
    });
    for await (const chunk of chunks(file.body)) {
      if (!parser.push(chunk)) break;
    }
    if (parser.end() === null) {
      onStale();
      throw new Error(`archive ${key} has a corrupt central directory`);
    }
  };

  return {
    entryCount,
    etag: directory.etag,
    rootPrefix: rules.rootPrefix,
    from: "directory",
    async find(path) {
      let found: TableEntry | null = null;
      await pass((p, record) => {
        if (p === path) found = toEntry(p, record);
      });
      return found;
    },
    async list(query) {
      const after = query.after ? encoder.encode(query.after) : null;
      const items = new Map<string, { key: Uint8Array; entry: TableEntry | null }>();
      let ceiling: Uint8Array | null = null;
      let more = false;
      const prune = () => {
        const kept = [...items.entries()].sort(([, a], [, b]) => compare(a.key, b.key)).slice(0, query.limit);
        items.clear();
        for (const [k, v] of kept) items.set(k, v);
        ceiling = kept[kept.length - 1][1].key;
        more = true;
      };

      await pass((path, record) => {
        if (!path.startsWith(query.prefix)) return;
        if (after && compare(encoder.encode(path), after) <= 0) return;
        const split = query.delimiter ? path.indexOf(query.delimiter, query.prefix.length) : -1;
        const common = split >= 0 ? path.slice(0, split + query.delimiter.length) : null;
        if (common !== null && common === query.after) return;
        const id = common ?? path;
        const key = encoder.encode(id);
        if (ceiling && compare(key, ceiling) > 0) {
          more = true;
          return;
        }
        items.set(id, { key, entry: common === null ? toEntry(path, record) : null });
        if (items.size > query.limit * 2 + 1024) prune();
      });

      const sorted = [...items.entries()].sort(([, a], [, b]) => compare(a.key, b.key));
      if (sorted.length > query.limit) more = true;
      const page = sorted.slice(0, query.limit);
      const result: ListResult = { entries: [], commonPrefixes: [] };
      for (const [id, { entry }] of page) {
        if (entry) result.entries.push(entry);
        else result.commonPrefixes.push(id);
      }
      if (more && page.length > 0) result.next = page[page.length - 1][0];
      return result;
    },
  };
}

function startsWith(name: Uint8Array, prefix: Uint8Array): boolean {
  if (name.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) if (name[i] !== prefix[i]) return false;
  return true;
}

function indexOf(name: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.byteLength <= name.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) if (name[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The smallest byte string greater than every string that starts with `prefix`. UTF-8 never holds 0xff, so the last byte can always be bumped. */
function successor(prefix: Uint8Array): Uint8Array {
  const next = prefix.slice();
  next[next.byteLength - 1]++;
  return next;
}
