import type { FileStorage } from "../asset/repository";
import { chunks, createDirectoryParser, type CdRecord, type Directory } from "./zip/directory";
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
  /** Where the central directory starts: no entry's data may reach past it. */
  readonly dataEnd: number;
  readonly rootPrefix: string;
  find(path: string): Promise<TableEntry | null>;
  list(query: ListQuery): Promise<ListResult>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function memoryView(table: EntryTable, entryCount: number, rootPrefix: string, directory: Pick<Directory, "offset" | "etag">): TableView {
  return {
    entryCount,
    etag: directory.etag,
    dataEnd: directory.offset,
    rootPrefix,
    async find(path) {
      const key = encoder.encode(path);
      const i = lowerBound(table, key);
      return i < table.count && compare(nameAt(table, i), key) === 0 ? entryAt(table, i) : null;
    },
    async list(query) {
      const prefix = encoder.encode(query.prefix);
      const delimiter = encoder.encode(query.delimiter);
      const result: ListResult = { entries: [], commonPrefixes: [] };
      let i = lowerBound(table, prefix);
      if (query.after) i = Math.max(i, upperBound(table, encoder.encode(query.after)));
      let last = "";
      while (i < table.count) {
        const name = nameAt(table, i);
        if (!startsWith(name, prefix)) break;
        const split = delimiter.byteLength > 0 ? indexOf(name, delimiter, prefix.byteLength) : -1;
        const common = split >= 0 ? name.subarray(0, split + delimiter.byteLength) : null;
        if (common) {
          i = lowerBound(table, successor(common));
          const value = decoder.decode(common);
          if (value === query.after) continue;
          if (result.entries.length + result.commonPrefixes.length === query.limit) return { ...result, next: last };
          result.commonPrefixes.push(value);
          last = value;
          continue;
        }
        if (result.entries.length + result.commonPrefixes.length === query.limit) return { ...result, next: last };
        const entry = entryAt(table, i++);
        result.entries.push(entry);
        last = entry.path;
      }
      return result;
    },
  };
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
    dataEnd: directory.offset,
    rootPrefix: rules.rootPrefix,
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
