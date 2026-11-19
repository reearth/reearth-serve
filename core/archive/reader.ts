import type { StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";
import type { ArchiveCache, Built } from "./cache";
import { contentTypeOf } from "./content-type";
import { buildTable, createSurvey, type TableEntry } from "./table";
import { gzipMember, GZIP_HEADER_BYTES, GZIP_TRAILER_BYTES } from "./transmux";
import { memoryView, scanView, type TableView } from "./views";
import { chunks, createDirectoryParser, locateDirectory, readAll, type Directory, type DirectoryRefusal } from "./zip/directory";
import { readEntryBytes, type ArchiveObject, type Span } from "./zip/entry";

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
  /** The container index object recorded in the row's `container.index`. Readers take it from there and never derive it. */
  index?: string;
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

export type ArchiveOpenFailure = "not-found" | "unsupported-method" | "encrypted" | "corrupt" | "changed";

export type ArchiveOpenResult =
  | { ok: true; file: StoredFile; originalSize: number }
  | { ok: false; reason: ArchiveOpenFailure };

export interface ArchiveReader {
  /** The lone root folder stripped from every path, "" when none. */
  readonly rootPrefix: string;
  /** Records in the central directory, directories and duplicates included. */
  readonly entryCount: number;
  stat(path: ArchivePath): Promise<ArchiveEntryInfo | null>;
  list(query: ArchiveListQuery): Promise<ArchiveListPage>;
  open(path: ArchivePath, options?: { range?: Span | null }): Promise<ArchiveOpenResult>;
}

/**
 * Open a zip original for in-place reads. A warm open costs no storage reads.
 * A cold one costs one tail read, plus one central directory read when the
 * directory lies outside the last MiB. It never reads extracted objects or
 * the manifest.
 */
export async function openArchive(deps: ArchiveDeps, source: ArchiveSource): Promise<OpenResult> {
  const cacheKey = `${source.key}#${source.size}`;
  const evict = () => deps.archives.evict(cacheKey);
  let builtThisRequest = false;
  const built = await deps.archives.load(cacheKey, () => {
    builtThisRequest = true;
    return buildView(deps.storage, source, evict);
  });
  if (!built.ok) return built;
  const archive: ArchiveObject = { storage: deps.storage, key: source.key, size: source.size, etag: built.view.etag };
  return { ok: true, reader: readerOver(built.view, archive, { builtThisRequest, evict }) };
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
    return { ok: true, view: scanView(storage, source.key, directory, survey, onStale), bytes: 256 };
  }

  const cd = directory.bytesFromTail ?? (await readDirectory(storage, source.key, directory));
  if (!cd) return { ok: false, reason: "missing" };
  const survey = createSurvey(source.filename);
  const parser = createDirectoryParser(directory, survey.observe);
  if (!parser.push(cd) || parser.end() === null) return { ok: false, reason: "corrupt" };
  const rules = survey.result();
  const table = buildTable(cd, directory, rules);
  if (!table) return { ok: false, reason: "corrupt" };
  return {
    ok: true,
    view: memoryView(table, directory.entryCount, rules.rootPrefix, directory.etag),
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
  return parser.end() === null ? null : survey.result();
}

function readerOver(view: TableView, archive: ArchiveObject, cached: { builtThisRequest: boolean; evict: () => void }): ArchiveReader {
  const stale = (): ArchiveOpenResult => {
    cached.evict();
    return { ok: false, reason: "changed" };
  };
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
    async open(path, options) {
      const entry = await view.find(path);
      if (!entry) return { ok: false, reason: "not-found" };
      const info = toInfo(entry);
      if (!info.readable) return { ok: false, reason: info.unreadableReason === "encrypted" ? "encrypted" : "unsupported-method" };

      const range = entry.method === STORED && options?.range ? clamp(options.range, entry.size) : null;
      const read = await readEntryBytes(archive, entry, range ?? undefined);
      if (!read.ok) {
        if (read.reason === "mismatch" && cached.builtThisRequest) return { ok: false, reason: "corrupt" };
        return stale();
      }

      const etag = entryEtag(view.etag, entry);
      const file: StoredFile = entry.method === STORED
        ? { body: read.body, size: entry.size, contentType: info.contentType, etag, ...(range && { range: { ...range, totalSize: entry.size } }) }
        : {
            body: gzipMember(read.body, entry.crc32, entry.size),
            size: GZIP_HEADER_BYTES + entry.compressedSize + GZIP_TRAILER_BYTES,
            contentType: info.contentType,
            contentEncoding: "gzip",
            etag,
          };
      return { ok: true, file, originalSize: entry.size };
    },
  };
}

function clamp(range: Span, size: number): Span {
  const offset = Math.min(range.offset, size);
  return { offset, length: Math.min(range.length, size - offset) };
}

function entryEtag(archiveEtag: string | undefined, entry: TableEntry): string {
  const crc = entry.crc32.toString(16).padStart(8, "0");
  const original = archiveEtag?.replace(/^W\//, "").replace(/"/g, "");
  return original ? `"${original}-${crc}"` : `"${crc}-${entry.size.toString(16)}"`;
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
