import type { FileStorage } from "../asset/repository";
import type { ArchiveCache, Built } from "./cache";
import { contentTypeOf } from "./content-type";
import { buildTable, createSurvey, type TableEntry } from "./table";
import { memoryView, scanView, type TableView } from "./views";
import { chunks, createDirectoryParser, locateDirectory, readAll, type Directory, type DirectoryRefusal } from "./zip/directory";

const MEMORY_DIRECTORY_LIMIT = 32 * 1024 * 1024;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const STORED = 0;
const DEFLATE = 8;
const ENCRYPTED = 0x1;

/**
 * A path inside an archive as Serve exposes it: UTF-8, `/`-separated, no
 * leading slash, no `.` or `..` segments, root prefix already stripped. The
 * same string the extractor uses after `files/`.
 */
export type ArchivePath = string & { readonly __brand: "ArchivePath" };

export function toArchivePath(raw: string): ArchivePath | null {
  if (raw === "" || raw.includes("\\")) return null;
  const segments = raw.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? (raw as ArchivePath) : null;
}

export interface ArchiveSource {
  key: string;
  size: number;
  /** The uploaded filename, which decides whether a lone root folder is stripped. */
  filename: string;
}

export interface ArchiveDeps {
  storage: FileStorage;
  archives: ArchiveCache;
}

export type OpenRefusal = DirectoryRefusal;
export type OpenResult = { ok: true; reader: ArchiveReader } | { ok: false; reason: OpenRefusal };

export interface ArchiveEntryInfo {
  path: ArchivePath;
  size: number;
  crc32: number;
  contentType: string;
  /** False for an entry Serve lists but cannot decode: an encrypted one, or a method other than store and deflate. */
  readable: boolean;
  unreadableReason?: "method" | "encrypted";
}

export interface ArchiveListQuery {
  prefix?: string;
  delimiter?: string;
  /** Exclusive: a key or common prefix from a previous page's `next`, or any key. */
  after?: string;
  /** 1 to 10,000; 1,000 when absent. */
  limit?: number;
}

export interface ArchiveListPage {
  entries: ArchiveEntryInfo[];
  commonPrefixes: string[];
  next?: string;
}

export interface ArchiveReader {
  /** The lone root folder stripped from every path, "" when none. */
  readonly rootPrefix: string;
  /** Records in the central directory, directories and duplicates included. */
  readonly entryCount: number;
  stat(path: ArchivePath): Promise<ArchiveEntryInfo | null>;
  list(query: ArchiveListQuery): Promise<ArchiveListPage>;
}

/**
 * Open a zip original for in-place reads. A warm open costs no storage reads.
 * A cold one costs one tail read, plus one central directory read when the
 * directory lies outside the last MiB. It never reads extracted objects or
 * the manifest.
 */
export async function openArchive(deps: ArchiveDeps, source: ArchiveSource): Promise<OpenResult> {
  const cacheKey = `${source.key}#${source.size}`;
  const built = await deps.archives.load(cacheKey, () =>
    buildView(deps.storage, source, () => deps.archives.evict(cacheKey)),
  );
  if (!built.ok) return built;
  return { ok: true, reader: readerOver(built.view) };
}

export async function buildView(
  storage: FileStorage,
  source: ArchiveSource,
  onStale: () => void,
  memoryLimit = MEMORY_DIRECTORY_LIMIT,
): Promise<Built> {
  const located = await locateDirectory(storage, source.key, source.size);
  if (!located.ok) return located;
  const directory = located.directory;

  if (directory.size > memoryLimit) {
    const survey = await surveyStream(storage, source, directory);
    if (!survey) return { ok: false, reason: "corrupt" };
    return { ok: true, view: scanView(storage, source.key, directory, survey.rules, survey.recordCount, onStale), bytes: 256 };
  }

  const cd = directory.bytesFromTail ?? (await readDirectory(storage, source.key, directory));
  if (!cd) return { ok: false, reason: "missing" };
  const survey = createSurvey(source.filename);
  const parser = createDirectoryParser(directory, survey.observe);
  if (!parser.push(cd) || parser.end() === null) return { ok: false, reason: "corrupt" };
  const rules = survey.result();
  const built = buildTable(cd, directory, rules);
  if (!built) return { ok: false, reason: "corrupt" };
  const { table, recordCount } = built;
  return {
    ok: true,
    view: memoryView(table, recordCount, rules.rootPrefix),
    bytes: table.records.byteLength + table.names.byteLength,
  };
}

async function readDirectory(storage: FileStorage, key: string, directory: Directory): Promise<Uint8Array | null> {
  const file = await storage.get(key, { offset: directory.offset, length: directory.size });
  return file && readAll(file.body, directory.size);
}

async function surveyStream(storage: FileStorage, source: ArchiveSource, directory: Directory) {
  const file = await storage.get(source.key, { offset: directory.offset, length: directory.size });
  if (!file) return null;
  const survey = createSurvey(source.filename);
  const parser = createDirectoryParser(directory, survey.observe);
  for await (const chunk of chunks(file.body)) {
    if (!parser.push(chunk)) return null;
  }
  const recordCount = parser.end();
  return recordCount === null ? null : { rules: survey.result(), recordCount };
}

function readerOver(view: TableView): ArchiveReader {
  return {
    rootPrefix: view.rootPrefix,
    entryCount: view.entryCount,
    async stat(path) {
      const entry = await view.find(path);
      return entry && toInfo(entry);
    },
    async list(query) {
      const page = await view.list({
        prefix: query.prefix ?? "",
        delimiter: query.delimiter ?? "",
        after: query.after ?? "",
        limit: Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT),
      });
      return { entries: page.entries.map(toInfo), commonPrefixes: page.commonPrefixes, ...(page.next !== undefined && { next: page.next }) };
    },
  };
}

function toInfo(entry: TableEntry): ArchiveEntryInfo {
  const info: ArchiveEntryInfo = {
    path: entry.path as ArchivePath,
    size: entry.size,
    crc32: entry.crc32,
    contentType: contentTypeOf(entry.path),
    readable: true,
  };
  if (entry.flags & ENCRYPTED) return { ...info, readable: false, unreadableReason: "encrypted" };
  if (entry.method !== STORED && entry.method !== DEFLATE) return { ...info, readable: false, unreadableReason: "method" };
  return info;
}
