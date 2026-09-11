/**
 * A minimal, dependency-free ZIP writer for `upload <dir>` (ADR-013 C2).
 *
 * **Stored, never deflated.** The extractor transmuxes deflate into gzip on the
 * way into storage anyway (ADR-001), so compressing here would spend the user's
 * CPU to produce bytes the server immediately undoes — and the local step is
 * the one the user waits on. Storing also makes the writer trivial enough to be
 * worth not taking a dependency for: Node ships no zip.
 *
 * **No ZIP64.** A site that does not fit in 4 GiB is not the case this command
 * exists for, and the ZIP64 end-of-central-directory records would double the
 * writer for a case that should be zipped by hand. Anything over the 32-bit
 * limits is refused with a message that says so.
 */

import { createWriteStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import * as zlib from "node:zlib";

/**
 * Entries that are never part of a built site: editor and OS droppings, the
 * repository, and the dependency tree that produced `dist/` in the first place.
 * Matched on the entry's own name, at any depth.
 */
export const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".git",
  "node_modules",
]);

/** 32-bit ZIP fields cap sizes and offsets here; past it, ZIP64 would be needed. */
export const ZIP32_MAX_BYTES = 0xffffffff;
/** …and the entry count, in the end-of-central-directory record. */
export const ZIP32_MAX_ENTRIES = 0xffff;

const READ_CHUNK = 1 << 20;

/** One file destined for the archive. */
export interface ZipInput {
  /** Path inside the zip: always forward slashes, always relative to the root. */
  name: string;
  /** Absolute path on disk. */
  file: string;
  size: number;
}

export interface CollectResult {
  entries: ZipInput[];
  /** Symbolic links that were skipped, as zip-relative paths. */
  skippedSymlinks: string[];
  totalSize: number;
}

// --- CRC-32 ---------------------------------------------------------------

/**
 * `zlib.crc32` exists from Node 22.2; CI pins Node 22, which resolves to a
 * later patch than that, but a table is eight lines and removes the question
 * entirely for anyone running an older runtime.
 */
const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `data`, continuing from `seed` (zlib's convention, so both agree). */
export function crc32(data: Uint8Array, seed = 0): number {
  if (nativeCrc32) return nativeCrc32(data, seed);
  let crc = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return ~crc >>> 0;
}

// --- Walking --------------------------------------------------------------

/**
 * Every file under `root`, with forward-slash paths relative to it.
 *
 * Symbolic links are **not** followed and not stored: a link out of the tree
 * would upload something the user did not mean to publish, and a link inside it
 * would be duplicated silently. They are reported so the caller can warn.
 *
 * Empty directories are dropped. The archive carries no directory entries at
 * all — nothing in delivery needs them, since paths are looked up whole.
 */
export async function collectDirectory(root: string): Promise<CollectResult> {
  const entries: ZipInput[] = [];
  const skippedSymlinks: string[] = [];
  let totalSize = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    // Sorted so the same directory always produces the same archive.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (SKIPPED_NAMES.has(dirent.name)) continue;
      const full = join(dir, dirent.name);
      const name = `${prefix}${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        skippedSymlinks.push(name);
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(full, `${name}/`);
        continue;
      }
      if (!dirent.isFile()) continue;
      const size = (await stat(full)).size;
      entries.push({ name, file: full, size });
      totalSize += size;
    }
  }

  await walk(root, "");
  return { entries, skippedSymlinks, totalSize };
}

// --- Writing --------------------------------------------------------------

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** Bit 11: the name is UTF-8. Set unconditionally — we only ever write UTF-8. */
const FLAG_UTF8 = 0x800;
/** 1980-01-01 00:00, the DOS epoch: a fixed stamp keeps the output reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export interface ZipSummary {
  entries: number;
  /** Size of the written archive. */
  bytes: number;
  skippedSymlinks: string[];
}

/**
 * Refuse anything the 32-bit records cannot describe, before a byte is written.
 *
 * The message names the way out rather than the format: a user who has a 5 GiB
 * site does not need to hear about ZIP64 end-of-central-directory locators.
 */
function guardZip32(entries: ZipInput[], totalSize: number): void {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error(
      `This directory has ${entries.length} files, more than the ${ZIP32_MAX_ENTRIES} ` +
      "this command can pack. Zip it yourself and upload the zip.",
    );
  }
  // Headers add to the total; a generous allowance still leaves the check well
  // clear of the boundary, and nothing near 4 GiB is a site anyway.
  const overhead = entries.reduce(
    (n, e) => n + LOCAL_HEADER_SIZE + CENTRAL_HEADER_SIZE + 2 * Buffer.byteLength(e.name),
    EOCD_SIZE,
  );
  if (totalSize + overhead > ZIP32_MAX_BYTES) {
    throw new Error(
      "This directory is larger than 4 GiB, which needs a ZIP64 archive. " +
      "Zip it yourself (any zip tool writes ZIP64) and upload the zip.",
    );
  }
}

/** CRC-32 of a file, streamed — the size is not bounded by memory. */
async function crcOfFile(path: string): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let crc = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, null);
      if (bytesRead === 0) return crc;
      crc = crc32(buf.subarray(0, bytesRead), crc);
    }
  } finally {
    await fh.close();
  }
}

function localHeader(name: Buffer, size: number, crc: number): Buffer {
  const head = Buffer.alloc(LOCAL_HEADER_SIZE);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed: 2.0
  head.writeUInt16LE(FLAG_UTF8, 6);
  head.writeUInt16LE(0, 8); // method: stored
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(size, 18); // compressed size == uncompressed size
  head.writeUInt32LE(size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // no extra field
  return Buffer.concat([head, name]);
}

function centralHeader(name: Buffer, size: number, crc: number, offset: number): Buffer {
  const head = Buffer.alloc(CENTRAL_HEADER_SIZE);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(FLAG_UTF8, 8);
  head.writeUInt16LE(0, 10); // method: stored
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(size, 20);
  head.writeUInt32LE(size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra length
  head.writeUInt16LE(0, 32); // comment length
  head.writeUInt16LE(0, 34); // disk number
  head.writeUInt16LE(0, 36); // internal attributes
  head.writeUInt32LE(0, 38); // external attributes
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(size, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return eocd;
}

/** Write one chunk, respecting back-pressure. */
function writeChunk(out: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Write `entries` to `dest` as a stored zip.
 *
 * Each file is read twice: once for its CRC, once for its bytes. A zip's local
 * header carries the CRC *before* the data, and the alternative — a trailing
 * data descriptor — asks more of every reader for no benefit here. Both passes
 * stream, so peak memory is one chunk regardless of file size.
 */
export async function writeStoredZip(entries: ZipInput[], dest: string): Promise<ZipSummary> {
  const totalSize = entries.reduce((n, e) => n + e.size, 0);
  guardZip32(entries, totalSize);

  const out = createWriteStream(dest);
  const central: Buffer[] = [];
  let offset = 0;

  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const crc = await crcOfFile(entry.file);
      const header = localHeader(name, entry.size, crc);
      await writeChunk(out, header);
      offset += header.length;

      const fh = await open(entry.file, "r");
      try {
        const buf = Buffer.allocUnsafe(READ_CHUNK);
        let written = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, READ_CHUNK, null);
          if (bytesRead === 0) break;
          await writeChunk(out, Buffer.from(buf.subarray(0, bytesRead)));
          written += bytesRead;
        }
        // A file that changed under us would corrupt the archive silently:
        // the header already promised `entry.size` bytes.
        if (written !== entry.size) {
          throw new Error(`${entry.name} changed while it was being packed`);
        }
      } finally {
        await fh.close();
      }

      central.push(centralHeader(name, entry.size, crc, offset - header.length));
      offset += entry.size;
    }

    const centralOffset = offset;
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    for (const block of central) await writeChunk(out, block);
    await writeChunk(out, endOfCentralDirectory(central.length, centralSize, centralOffset));
  } finally {
    out.end();
  }
  await finished(out);

  return {
    entries: entries.length,
    bytes: offset + central.reduce((n, b) => n + b.length, 0) + EOCD_SIZE,
    skippedSymlinks: [],
  };
}

/** Pack a whole directory into `dest`. The archive root is the directory's contents. */
export async function zipDirectory(root: string, dest: string): Promise<ZipSummary> {
  const { entries, skippedSymlinks } = await collectDirectory(root);
  if (entries.length === 0) {
    throw new Error(`${basename(root)} has no files to upload`);
  }
  const summary = await writeStoredZip(entries, dest);
  return { ...summary, skippedSymlinks };
}
