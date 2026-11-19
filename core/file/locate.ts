import { openArchive, toArchivePath, type ArchiveCache, type ArchiveOpenFailure, type ArchiveSource } from "../archive";
import { archiveSource, assetLayouts, entryKey, mainKey, type Layout } from "../asset/layout";
import type { AssetMetadata, AssetVersion, StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";

export const INDEX_FILE = "index.html";
const NOT_FOUND_FILE = "404.html";

type Span = { offset: number; length: number };

export interface Located {
  file: StoredFile;
  contentType: string;
  contentEncoding?: string;
  displayName: string;
  originalSize?: number;
  /** Re-reads the object for a Range the first read did not apply. */
  rangeRead?: (range: Span) => Promise<StoredFile | null>;
}

/** An entry that exists in place but cannot be served: 501 for what Serve cannot decode, 502 for a broken original. */
export interface Refused {
  refused: 501 | 502;
  error: string;
}

export type Lookup = Located | Refused | null;

export function isRefused(lookup: Lookup): lookup is Refused {
  return lookup !== null && "refused" in lookup;
}

/** Everything one request needs to find an asset's bytes. */
export interface FileSource {
  storage: FileStorage;
  archives: ArchiveCache;
  layouts: Layout[];
  /**
   * True when the extracted tree may hold the entry: the serving row says
   * extraction finished, or the original cannot be read in place. A zip that
   * is pending, failed or uploaded with extraction skipped is read only in
   * place, so an entry costs one read and never a miss first.
   */
  extracted: boolean;
  /** The resolved row's own original, when it can be read in place. */
  inPlace: ArchiveSource | null;
}

export function fileSource(
  deps: { storage: FileStorage; archives: ArchiveCache },
  asset: AssetMetadata,
  version: AssetVersion | null,
): FileSource {
  const layouts = assetLayouts(asset, version);
  const inPlace = layouts[0].archive ? archiveSource(layouts[0]) : null;
  return {
    ...deps,
    layouts,
    extracted: (version ?? asset).status === "ready" || !inPlace,
    inPlace,
  };
}

/**
 * Map a request path onto the bytes to serve.
 *
 * - Empty path or trailing slash → the directory's `index.html` (archives) or
 *   the uploaded file itself (single-file assets).
 * - The archive's own filename → the archive.
 * - Anything else on an archive → the extracted entry at that path, then the
 *   same entry read in place from the original (ADR-018). Extracted objects go
 *   first so an archive that finished extraction serves exactly what it did
 *   before in-place reads existed.
 * - Anything else on a single-file asset → the uploaded file. The path after
 *   the ID has never been checked for single-file assets, and links in the
 *   wild depend on that.
 */
export async function locate(src: FileSource, filePath: string, range: Span | null): Promise<Lookup> {
  const wantsDirectory = filePath === "" || filePath.endsWith("/");
  const entryPath = wantsDirectory ? `${filePath}${INDEX_FILE}` : filePath;
  let wantsEntry = false;
  for (const layout of src.layouts) {
    if (!layout.archive || (!wantsDirectory && filePath === layout.filename)) {
      const found = await locateMain(src.storage, layout);
      if (found) return found;
      continue;
    }
    wantsEntry = true;
    const found = src.extracted ? await locateExtracted(src.storage, layout, entryPath) : null;
    if (found) return found;
  }
  return wantsEntry ? locateInPlace(src, entryPath, range) : null;
}

async function locateMain(storage: FileStorage, layout: Layout): Promise<Located | null> {
  const key = mainKey(layout);
  const file = await storage.get(key);
  if (!file) return null;
  return {
    file,
    contentType: layout.contentType,
    contentEncoding: layout.contentEncoding,
    displayName: layout.filename,
    originalSize: layout.originalSize,
    rangeRead: (range) => storage.get(key, range),
  };
}

async function locateExtracted(storage: FileStorage, layout: Layout, entryPath: string): Promise<Located | null> {
  const key = entryKey(layout, entryPath);
  const file = await storage.get(key);
  if (!file) return null;
  return {
    file,
    contentType: file.contentType,
    contentEncoding: file.contentEncoding,
    displayName: displayName(entryPath),
    rangeRead: (range) => storage.get(key, range),
  };
}

const REFUSALS: Record<Exclude<ArchiveOpenFailure, "not-found" | "changed">, Refused> = {
  "unsupported-method": { refused: 501, error: "This archive entry uses a compression method Serve cannot decode" },
  encrypted: { refused: 501, error: "This archive entry is encrypted" },
  corrupt: { refused: 502, error: "The archive's local header contradicts its central directory" },
};

/**
 * A stored entry with a Range costs one bounded read, a deflate entry comes
 * back as one gzip member, and an original replaced since its central
 * directory was cached is re-read once before the request gives up.
 */
async function locateInPlace(src: FileSource, entryPath: string, range: Span | null): Promise<Lookup> {
  const path = toArchivePath(entryPath);
  if (!src.inPlace || !path) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await openArchive(src, src.inPlace);
    if (!opened.ok) {
      if (opened.reason !== "missing" && opened.reason !== "not-zip") console.warn(`files: ${src.inPlace.key} is not readable in place (${opened.reason})`);
      return null;
    }
    const read = await opened.reader.open(path, { range });
    if (read.ok) {
      return {
        file: read.file,
        contentType: read.file.contentType,
        contentEncoding: read.file.contentEncoding,
        displayName: displayName(path),
        originalSize: read.originalSize,
      };
    }
    if (read.reason === "not-found") return null;
    if (read.reason !== "changed") return REFUSALS[read.reason];
  }
  return { refused: 502, error: "The archive changed while it was being read" };
}

function displayName(path: string): string {
  return path.split("/").pop() || path;
}

/** True when `path` names a directory that has an index file, extracted or in place. */
export async function hasIndex(src: FileSource, path: string): Promise<boolean> {
  const name = `${path}/${INDEX_FILE}`;
  if (src.extracted) {
    for (const layout of src.layouts) {
      if (layout.archive && (await src.storage.head(entryKey(layout, name)))) return true;
    }
  }
  const archivePath = toArchivePath(name);
  if (!src.inPlace || !archivePath) return false;
  const opened = await openArchive(src, src.inPlace);
  return opened.ok && (await opened.reader.stat(archivePath)) !== null;
}

/** Locate a file at the archive root; a root file that cannot be served counts as missing. */
async function locateRootFile(src: FileSource, name: string): Promise<Located | null> {
  const found = await locate({ ...src, layouts: src.layouts.filter((l) => l.archive) }, name, null);
  return isRefused(found) ? null : found;
}

/**
 * Does this missing path name a file rather than a client-side route?
 *
 * A 200 HTML body in place of a missing `.js` chunk, `.json` manifest or
 * `.b3dm` tile is worse than the 404 it replaces: a bundler's dynamic import
 * fails with a syntax error and a 3D Tiles viewer tries to parse HTML as a tile.
 * SPA routes, by contrast, are extensionless (`/about`, `/map/harbor`) or end
 * in a slash. So the fallback is withheld from anything whose last segment ends
 * in a short, file-like extension.
 *
 * This is a refinement of ADR-013 C1, which described the fallback without it.
 * The `404.html` branch is unaffected: it answers *with* status 404, so it
 * cannot mislead a loader the way a 200 can.
 */
export function looksLikeAssetPath(filePath: string): boolean {
  return /\.[a-z0-9]{1,8}$/.test(filePath.toLowerCase());
}

/**
 * What an archive miss falls back to (ADR-013 C1), after the A1 lookup and the
 * directory-redirect probe have both missed.
 *
 * At most one extra lookup: `spa` is checked first and, when it is on and the
 * path is not file-shaped, `404.html` is never looked for. A hit costs nothing
 * new, since this runs only on a miss.
 */
export async function archiveFallback(
  src: FileSource,
  filePath: string,
  spa: boolean,
): Promise<{ kind: "spa" | "notFound"; located: Located } | null> {
  if (!src.layouts.some((l) => l.archive)) return null;

  if (spa && !looksLikeAssetPath(filePath)) {
    const index = await locateRootFile(src, INDEX_FILE);
    return index ? { kind: "spa", located: index } : null;
  }

  const page = await locateRootFile(src, NOT_FOUND_FILE);
  return page ? { kind: "notFound", located: page } : null;
}
