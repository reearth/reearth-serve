import { afterEach, describe, expect, test, vi } from "vitest";
import { MemoryFileStorage } from "../../../adapters/memory/storage";
import { writeZip, type SyntheticEntry } from "../../../adapters/memory/zip";
import type { FileStorage } from "../repository";
import type { AtomicWrites, MetadataStore, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import { createArchiveCache, openArchive, toArchivePath } from "../../archive";
import { archiveSource, assetLayouts } from "../layout";
import type { AssetMetadata } from "../model";
import { completeUploadSession } from "./complete-upload-session";
import { containerIndexKey, finaliseArchive } from "./finalise-archive";
import { uploadAsset } from "./upload";
import { uploadVersion } from "./upload-version";

const text = (s: string) => new TextEncoder().encode(s);
const ROOT = "assets/a1";
const FILENAME = "site.zip";

// About 1.3 MB of central directory, so it cannot be answered from the 1 MiB tail.
function manyEntries(count = 10_000): SyntheticEntry[] {
  return Array.from({ length: count }, (_, i) => ({ name: `tiles/${String(i).padStart(8, "0")}/${"n".repeat(64)}.json`, data: text(`{"i":${i}}`) }));
}

async function stored(entries: SyntheticEntry[], storage = new MemoryFileStorage()) {
  const bytes = writeZip(entries);
  await storage.put(`${ROOT}/${FILENAME}`, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  return { storage, size: bytes.byteLength };
}

async function objectBytes(storage: FileStorage, key: string): Promise<Uint8Array | null> {
  const file = await storage.get(key);
  return file ? new Uint8Array(await new Response(file.body).arrayBuffer()) : null;
}

const input = (size: number, archiveFormat: "zip" | "tar" | null = "zip") => ({ root: ROOT, filename: FILENAME, size, archiveFormat });

afterEach(() => vi.restoreAllMocks());

describe("finaliseArchive", () => {
  test("builds the index for a directory beyond the tail and records where it is", async () => {
    const { storage, size } = await stored(manyEntries());
    const result = await finaliseArchive({ storage }, input(size));
    expect(result.container).toMatchObject({ index: containerIndexKey(ROOT), rootPrefix: "" });
    expect(result.container?.directory.size).toBeGreaterThan(1024 * 1024);
    expect(await objectBytes(storage, containerIndexKey(ROOT))).not.toBeNull();
  });

  test("records small when the directory fits the tail read, and writes no index", async () => {
    const { storage, size } = await stored([{ name: "index.html", data: text("<p>hi</p>") }]);
    const result = await finaliseArchive({ storage }, input(size));
    expect(result.container).toMatchObject({ skipped: "small" });
    expect(await objectBytes(storage, containerIndexKey(ROOT))).toBeNull();
  });

  test("records too-large above the threshold, and writes no index", async () => {
    const { storage, size } = await stored(manyEntries());
    const result = await finaliseArchive({ storage, limits: { maxEntries: 100, maxDirectoryBytes: 20 * 1024 * 1024 } }, input(size));
    expect(result.container).toMatchObject({ skipped: "too-large" });
    expect(await objectBytes(storage, containerIndexKey(ROOT))).toBeNull();
  });

  test("a failing index put records no container and does not throw", async () => {
    const memory = new MemoryFileStorage();
    const { size } = await stored(manyEntries(), memory);
    const storage: FileStorage = {
      put: async (key, ...rest) => {
        if (key === containerIndexKey(ROOT)) throw new Error("injected put failure");
        return memory.put(key, ...rest);
      },
      get: (k, r) => memory.get(k, r),
      head: (k) => memory.head(k),
      delete: (k) => memory.delete(k),
      list: (p, o) => memory.list(p, o),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await finaliseArchive({ storage }, input(size));
    expect(result.container).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  test("a rerun writes identical index bytes and returns the same fields", async () => {
    const entries = [...manyEntries(), { name: "_redirects", data: text("/old /new 301\n") }];
    const { storage, size } = await stored(entries);
    const first = await finaliseArchive({ storage }, input(size));
    expect(first.container).toMatchObject({ index: containerIndexKey(ROOT) });
    const firstBytes = await objectBytes(storage, containerIndexKey(ROOT));
    const second = await finaliseArchive({ storage }, input(size));
    expect(second).toEqual(first);
    const secondBytes = await objectBytes(storage, containerIndexKey(ROOT));
    expect(Buffer.compare(Buffer.from(secondBytes!), Buffer.from(firstBytes!))).toBe(0);
  });

  test("parses _redirects in place into hosting", async () => {
    const { storage, size } = await stored([
      { name: "index.html", data: text("<p>hi</p>") },
      { name: "_redirects", data: text("/old /new 301\n") },
    ]);
    const result = await finaliseArchive({ storage }, input(size));
    expect(result.hosting?.redirects).toEqual([expect.objectContaining({ from: "/old", to: "/new", status: 301 })]);
  });

  test("records no hosting when neither control file exists", async () => {
    const { storage, size } = await stored([{ name: "index.html", data: text("<p>hi</p>") }]);
    expect((await finaliseArchive({ storage }, input(size))).hosting).toBeUndefined();
  });

  test("leaves a non-zip untouched", async () => {
    const storage = new MemoryFileStorage();
    const get = vi.spyOn(storage, "get");
    const put = vi.spyOn(storage, "put");
    expect(await finaliseArchive({ storage }, input(10, "tar"))).toEqual({});
    expect(await finaliseArchive({ storage }, input(10, null))).toEqual({});
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test("a .zip that is not a zip yields nothing and logs nothing", async () => {
    const storage = new MemoryFileStorage();
    await storage.put(`${ROOT}/${FILENAME}`, new Blob([new Uint8Array(64)]).stream(), "application/zip", 64);
    const errors = vi.spyOn(console, "error");
    expect(await finaliseArchive({ storage }, input(64))).toEqual({});
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("upload paths", () => {
  const failingWrites: AtomicWrites = {
    createAsset: async () => { throw new Error("D1 down"); },
    createVersion: async () => { throw new Error("D1 down"); },
    saveJob: async () => {},
    deleteAsset: async () => ({ deleted: false }) as never,
  };
  const zipBody = () => {
    const bytes = writeZip(manyEntries());
    return { body: new Blob([bytes as BlobPart]).stream(), size: bytes.byteLength };
  };

  test("uploadAsset writes container and hosting in the one row write", async () => {
    const storage = new MemoryFileStorage();
    const rows: unknown[] = [];
    const writes: AtomicWrites = { ...failingWrites, createAsset: async (i) => { rows.push(i.asset); } };
    const { body, size } = zipBody();
    const result = await uploadAsset(writes, storage, { name: FILENAME, type: "application/zip", body, size }, 60, "https://x");
    expect(rows).toHaveLength(1);
    expect(result.asset.container).toMatchObject({ index: containerIndexKey(`assets/${result.asset.id}`) });
  });

  test("a failed asset row write deletes the original and the index", async () => {
    const storage = new MemoryFileStorage();
    const { body, size } = zipBody();
    await expect(uploadAsset(failingWrites, storage, { name: FILENAME, type: "application/zip", body, size }, 60, "https://x")).rejects.toThrow("D1 down");
    expect((await storage.list("assets/")).keys).toEqual([]);
  });

  test("a version upload records the index under the version root, and a failed write deletes both", async () => {
    const storage = new MemoryFileStorage();
    const asset = { id: "a1", filename: FILENAME, contentType: "application/zip", size: 1, createdAt: 1, expiresAt: 0 };
    const metadata = { find: async () => asset } as unknown as MetadataStore;
    let saved: { id: string; container?: unknown } | undefined;
    const writes: AtomicWrites = { ...failingWrites, createVersion: async (i) => { saved = i.version; return i.version; } };
    const first = zipBody();
    await uploadVersion(metadata, writes, storage, "a1", { name: FILENAME, type: "application/zip", ...first }, "https://x");
    expect(saved?.container).toMatchObject({ index: containerIndexKey(`assets/a1/v/${saved!.id}`) });

    const empty = new MemoryFileStorage();
    const second = zipBody();
    await expect(uploadVersion(metadata, failingWrites, empty, "a1", { name: FILENAME, type: "application/zip", ...second }, "https://x")).rejects.toThrow("D1 down");
    expect((await empty.list("assets/")).keys).toEqual([]);
  });
});

describe("presigned multipart completion", () => {
  test("records the container index before the row write", async () => {
    const storage = new MemoryFileStorage();
    const bytes = writeZip(manyEntries());
    const session = { id: "mp1", filename: FILENAME, contentType: "application/zip", size: bytes.byteLength, createdAt: 1, expiresAt: 2, s3UploadId: "u1" };
    const sessions = { find: async () => session, save: async () => {}, delete: async () => {} } as unknown as UploadSessionStore;
    const presigned = {
      completeMultipartUpload: async (key: string) => storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength),
    } as unknown as PresignedUrlGenerator;
    const metadata = { find: async () => null } as unknown as MetadataStore;
    const rows: AssetMetadata[] = [];
    const writes = { createAsset: async (i: { asset: AssetMetadata }) => { rows.push(i.asset); } } as unknown as AtomicWrites;

    const result = await completeUploadSession(sessions, writes, metadata, storage, presigned, "mp1", 60, "https://x", [{ partNumber: 1, etag: "e" }]);
    expect(result?.asset.container).toMatchObject({ index: containerIndexKey("assets/mp1") });
    expect(rows[0].container).toEqual(result?.asset.container);
  });
});

describe("readers fall back to the central directory", () => {
  async function uploaded() {
    const storage = new MemoryFileStorage();
    const rows: AssetMetadata[] = [];
    const writes = { createAsset: async (i: { asset: AssetMetadata }) => { rows.push(i.asset); } } as unknown as AtomicWrites;
    const bytes = writeZip(manyEntries());
    await uploadAsset(writes, storage, { name: FILENAME, type: "application/zip", body: new Blob([bytes as BlobPart]).stream(), size: bytes.byteLength }, 60, "https://x");
    return { storage, asset: rows[0] };
  }

  async function readEntry(storage: FileStorage, asset: AssetMetadata, path: string): Promise<string> {
    const source = archiveSource(assetLayouts(asset, null)[0])!;
    const opened = await openArchive({ storage, archives: createArchiveCache() }, source);
    if (!opened.ok) throw new Error(opened.reason);
    const read = await opened.reader.open(toArchivePath(path)!);
    if (!read.ok) throw new Error(read.reason);
    return new Response(read.file.body).text();
  }

  const entry = `tiles/00004321/${"n".repeat(64)}.json`;

  test("the layout hands readers the index key from meta", async () => {
    const { asset } = await uploaded();
    expect(archiveSource(assetLayouts(asset, null)[0])?.index).toBe(containerIndexKey(`assets/${asset.id}`));
  });

  test("a missing index object still serves the entry", async () => {
    const { storage, asset } = await uploaded();
    await storage.delete(containerIndexKey(`assets/${asset.id}`));
    expect(await readEntry(storage, asset, entry)).toBe('{"i":4321}');
  });

  test("a garbage index object still serves the entry", async () => {
    const { storage, asset } = await uploaded();
    const garbage = text("SRVCIDX1 but not really an index at all");
    await storage.put(containerIndexKey(`assets/${asset.id}`), new Blob([garbage as BlobPart]).stream(), "application/octet-stream", garbage.byteLength);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readEntry(storage, asset, entry)).toBe('{"i":4321}');
  });
});
