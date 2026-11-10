// Workspace-scoped deduplication of direct uploads (ADR-017 §4, phase P3 as
// amended by the post-review change: no hash-only uploads),
// against the real SQL ledger and row writes and the in-memory object store.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSqliteClient } from "../../adapters/memory/sqlite-node";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { SqlBlobRefStore } from "../../adapters/sql/blob-refs";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import { SqlMetadataStore, SqlStorageUsageStore, SqlVersionStore } from "../../adapters/sql/stores";
import { ChecksumMismatchError, EMPTY_SHA256 } from "../asset/integrity";
import { uploadAsset } from "../asset/usecase/upload";
import { uploadVersion } from "../asset/usecase/upload-version";
import type { AssetMetadata } from "../asset/model";
import { blobRefKey } from "./model";
import { BlobUnavailableError, type BlobContext } from "./usecase";
import { storeDirectUpload } from "./direct-upload";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
const BASE = "https://serve.example";
const SCOPES = ["project:p1", "workspace:w1"];

/** A body that records whether it was read to its end. */
function trackedBody(data: Uint8Array, chunk = 3) {
  let offset = 0;
  const state = { finished: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        state.finished = true;
        controller.close();
        return;
      }
      controller.enqueue(data.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
  return { body, state };
}

const empty = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

let refs: SqlBlobRefStore;
let writes: SqlAtomicWrites;
let metadata: SqlMetadataStore;
let versions: SqlVersionStore;
let usage: SqlStorageUsageStore;
let storage: MemoryFileStorage;
const blobIn = (scope: string): BlobContext => ({ refs, scope });

beforeEach(() => {
  const sql = createSqliteClient();
  refs = new SqlBlobRefStore(sql);
  writes = new SqlAtomicWrites(sql);
  metadata = new SqlMetadataStore(sql);
  versions = new SqlVersionStore(sql);
  usage = new SqlStorageUsageStore(sql);
  storage = new MemoryFileStorage();
});

/** A first upload with a declared hash into workspace w1, as the route makes it. */
function upload(data: Uint8Array, opts: { name?: string; body?: ReadableStream<Uint8Array>; size?: number; sha?: string; type?: string; encoding?: string; originalSize?: number } = {}) {
  return uploadAsset(
    writes, storage,
    {
      name: opts.name ?? "data.bin", type: opts.type ?? "application/octet-stream",
      body: opts.body ?? trackedBody(data).body, size: opts.size ?? data.byteLength,
      sha256: opts.sha ?? sha256(data),
      ...(opts.encoding && { contentEncoding: opts.encoding }),
      ...(opts.originalSize && { originalSize: opts.originalSize }),
    },
    3600, BASE,
    { projectId: "p1", usageScopes: SCOPES, blob: blobIn("w1") },
  );
}

/** What two uploads of the same content must agree on: everything but identity and time. */
function comparable(asset: AssetMetadata) {
  const { id: _id, createdAt: _c, ...rest } = asset;
  return rest;
}

describe("storeDirectUpload", () => {
  test("a fresh declared upload is written to its blob key", async () => {
    const data = bytes("fresh");
    const put = vi.spyOn(storage, "put");
    const stored = await storeDirectUpload(storage, blobIn("w1"), {
      body: trackedBody(data).body, size: data.byteLength, contentType: "t", sha256: sha256(data),
    }, "assets/a/f");
    expect(stored).toEqual({ key: blobRefKey("w1", sha256(data)).key, ref: blobRefKey("w1", sha256(data)), sha256: sha256(data), size: 5 });
    expect(put).toHaveBeenCalledOnce();
  });

  test("bytes the scope already holds are read to the end and hashed, not written", async () => {
    const data = bytes("already stored here");
    await upload(data);
    const put = vi.spyOn(storage, "put");
    const digest = vi.spyOn(storage, "digest");

    const { body, state } = trackedBody(data);
    const stored = await storeDirectUpload(storage, blobIn("w1"), { body, size: data.byteLength, contentType: "t", sha256: sha256(data) }, "assets/b/f");

    expect(stored).toMatchObject({ reuse: { since: expect.any(Number) }, sha256: sha256(data), size: data.byteLength });
    expect(state.finished).toBe(true);
    expect(digest).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  test("a reused upload whose body does not match the declaration is still a mismatch", async () => {
    const data = bytes("the real bytes");
    await upload(data);
    const other = bytes("forged  bytes!");
    await expect(storeDirectUpload(storage, blobIn("w1"), {
      body: trackedBody(other).body, size: other.byteLength, contentType: "t", sha256: sha256(data),
    }, "assets/b/f")).rejects.toBeInstanceOf(ChecksumMismatchError);
  });

  test("a reused upload whose body overruns its Content-Length is refused like a written one", async () => {
    const data = bytes("exact");
    await upload(data);
    await expect(storeDirectUpload(storage, blobIn("w1"), {
      body: trackedBody(bytes("exact and more")).body, size: data.byteLength, contentType: "t", sha256: sha256(data),
    }, "assets/b/f")).rejects.toThrow(/declared Content-Length/);
  });

  test("bytes that exist only in another workspace are written again in this one", async () => {
    const data = bytes("someone else's file");
    await upload(data); // in w1
    const put = vi.spyOn(storage, "put");
    const stored = await storeDirectUpload(storage, blobIn("w2"), {
      body: trackedBody(data).body, size: data.byteLength, contentType: "t", sha256: sha256(data),
    }, "assets/b/f");
    expect(stored).toMatchObject({ key: blobRefKey("w2", sha256(data)).key });
    expect(put).toHaveBeenCalledOnce();
  });

  test("an empty body with a declared hash is a mismatch even when the scope holds those bytes, and the ledger is not consulted", async () => {
    const data = bytes("twenty-one bytes long");
    await upload(data); // in w1
    const find = vi.spyOn(refs, "find");
    const reserve = vi.spyOn(refs, "reserve");
    const put = vi.spyOn(storage, "put");
    for (const scope of ["w1", "w2"]) {
      await expect(storeDirectUpload(storage, blobIn(scope), { body: empty(), size: 0, contentType: "t", sha256: sha256(data) }, "assets/b/f"))
        .rejects.toEqual(new ChecksumMismatchError(sha256(data), EMPTY_SHA256));
    }
    expect(find).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await refs.find(blobRefKey("w2", sha256(data)).key)).toBeNull();
  });

  test("an empty body declaring the empty-string hash stores an empty file, and reuses it the second time", async () => {
    const first = await storeDirectUpload(storage, blobIn("w1"), { body: empty(), size: 0, contentType: "t", sha256: EMPTY_SHA256 }, "assets/a/f");
    expect(first).toMatchObject({ sha256: EMPTY_SHA256, size: 0, key: blobRefKey("w1", EMPTY_SHA256).key });
    expect((await storage.head(first.key))?.size).toBe(0);

    await upload(new Uint8Array(0), { body: empty() });
    const second = await storeDirectUpload(storage, blobIn("w1"), { body: empty(), size: 0, contentType: "t", sha256: EMPTY_SHA256 }, "assets/b/f");
    expect(second).toMatchObject({ reuse: { since: expect.any(Number) }, size: 0 });
  });

  test("a ledger that says ready but an object that is gone refuses the upload instead of recording it", async () => {
    const data = bytes("vanished");
    const { asset } = await upload(data);
    await storage.delete(asset.blobKey!);
    await expect(storeDirectUpload(storage, blobIn("w1"), {
      body: trackedBody(data).body, size: data.byteLength, contentType: "t", sha256: sha256(data),
    }, "assets/b/f")).rejects.toBeInstanceOf(BlobUnavailableError);
  });
});

describe("uploadAsset / uploadVersion with bytes already stored", () => {
  test("a duplicate upload's response is the same as a fresh one's, and usage moves per row", async () => {
    const data = bytes('{"type":"FeatureCollection"}');
    const fresh = await upload(data, { name: "a.json", type: "application/json", encoding: "gzip", originalSize: 99 });
    const usageAfterFirst = await usage.get("project:p1");
    const put = vi.spyOn(storage, "put");

    const dup = await upload(data, { name: "a.json", type: "application/json", encoding: "gzip", originalSize: 99 });
    expect(put).not.toHaveBeenCalled();
    expect(Object.keys(dup).sort()).toEqual(Object.keys(fresh).sort());
    expect(comparable(dup.asset)).toEqual(comparable(fresh.asset));
    expect(dup.asset).toMatchObject({ integrity: "verified", sha256: sha256(data), size: data.byteLength, contentEncoding: "gzip", originalSize: 99 });
    // The stored row is the same too.
    expect(comparable((await metadata.find(dup.asset.id))!)).toEqual(comparable((await metadata.find(fresh.asset.id))!));

    expect(await usage.get("project:p1")).toMatchObject({
      totalSize: usageAfterFirst!.totalSize + data.byteLength, assetCount: usageAfterFirst!.assetCount + 1,
    });
    expect(await usage.get("workspace:w1")).toMatchObject({ totalSize: 2 * data.byteLength, assetCount: 2 });
    expect(await refs.find(fresh.asset.blobKey!)).toMatchObject({ refCount: 2, state: "ready" });
  });

  test("an empty-bodied first upload naming stored bytes is refused like any wrong declaration: no row, no usage", async () => {
    const data = bytes("the full content");
    await upload(data, { name: "f.txt", type: "text/plain" });
    const before = await usage.get("workspace:w1");
    await expect(upload(data, { name: "f.txt", type: "text/plain", body: empty(), size: 0 })).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await usage.get("workspace:w1")).toEqual(before);
    expect(await refs.find(blobRefKey("w1", sha256(data)).key)).toMatchObject({ refCount: 1 });
  });

  test("a new version from bytes already stored: the body is read in full, verified, sized, counted, and not written again", async () => {
    const data = bytes("version content");
    const { asset } = await upload(data);
    const put = vi.spyOn(storage, "put");
    const tracked = trackedBody(data);

    const full = await uploadVersion(metadata, writes, storage, asset.id,
      { name: "data.bin", type: "application/octet-stream", body: tracked.body, size: data.byteLength, sha256: sha256(data) },
      BASE, { usageScopes: SCOPES, blob: blobIn("w1") });

    expect(tracked.state.finished).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(full!.version).toMatchObject({ integrity: "verified", sha256: sha256(data), size: data.byteLength, blobKey: asset.blobKey });
    expect(await refs.find(asset.blobKey!)).toMatchObject({ refCount: 2 });
    expect(await usage.get("workspace:w1")).toMatchObject({ totalSize: 2 * data.byteLength, assetCount: 2 });

    // A hash-only version is a wrong declaration, whatever the scope holds.
    await expect(uploadVersion(metadata, writes, storage, asset.id,
      { name: "data.bin", type: "application/octet-stream", body: empty(), size: 0, sha256: sha256(data) },
      BASE, { usageScopes: SCOPES, blob: blobIn("w1") })).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await refs.find(asset.blobKey!)).toMatchObject({ refCount: 2 });
  });

  test("the blob losing its last reference while the body is read: still attached, since its object is in its grace period", async () => {
    const data = bytes("raced away");
    const first = await upload(data);
    // The other asset is deleted while this upload's body is in flight.
    const realDigest = storage.digest.bind(storage);
    vi.spyOn(storage, "digest").mockImplementation(async (body, size) => {
      const result = await realDigest(body, size);
      await writes.deleteAsset({ asset: first.asset, usageScopes: SCOPES, cleanupPrefix: `assets/${first.asset.id}/` });
      return result;
    });

    const second = await upload(data);
    expect(second.asset.blobKey).toBe(first.asset.blobKey);
    expect(await refs.find(first.asset.blobKey!)).toMatchObject({ refCount: 1, state: "ready" });
    expect((await refs.find(first.asset.blobKey!))?.zeroSince).toBeUndefined();
    expect(await usage.get("workspace:w1")).toMatchObject({ totalSize: data.byteLength, assetCount: 1 });
  });

  test("a sweep locking the blob while the body is read: 409-able error, no row, no usage", async () => {
    const data = bytes("swept away");
    const first = await upload(data);
    const usageBefore = await usage.get("workspace:w1");
    const realDigest = storage.digest.bind(storage);
    vi.spyOn(storage, "digest").mockImplementation(async (body, size) => {
      const result = await realDigest(body, size);
      await writes.deleteAsset({ asset: first.asset, usageScopes: SCOPES, cleanupPrefix: `assets/${first.asset.id}/` });
      await refs.markDeleting(first.asset.blobKey!, Number.MAX_SAFE_INTEGER, Date.now());
      return result;
    });
    const createAsset = vi.spyOn(writes, "createAsset");

    const error = await upload(data).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobUnavailableError);
    // The message names no duplicate: it is the one answer only a duplicate can get.
    expect((error as Error).message).not.toMatch(/copy|duplicate|already|exist/i);

    expect(createAsset).toHaveBeenCalledOnce(); // tried, and the batch refused it
    const created = createAsset.mock.calls[0][0].asset.id;
    expect(await metadata.find(created)).toBeNull();
    expect(await usage.get("workspace:w1")).toMatchObject({ totalSize: usageBefore!.totalSize - data.byteLength, assetCount: usageBefore!.assetCount - 1 });
  });

  test("the same race on a new version", async () => {
    const data = bytes("raced version");
    const { asset } = await upload(bytes("v1 bytes"));
    const holder = await upload(data);
    const realDigest = storage.digest.bind(storage);
    vi.spyOn(storage, "digest").mockImplementation(async (body, size) => {
      const result = await realDigest(body, size);
      await writes.deleteAsset({ asset: holder.asset, usageScopes: SCOPES, cleanupPrefix: `assets/${holder.asset.id}/` });
      await refs.markDeleting(holder.asset.blobKey!, Number.MAX_SAFE_INTEGER, Date.now());
      return result;
    });
    await expect(uploadVersion(metadata, writes, storage, asset.id,
      { name: "data.bin", type: "application/octet-stream", body: trackedBody(data).body, size: data.byteLength, sha256: sha256(data) },
      BASE, { usageScopes: SCOPES, blob: blobIn("w1") })).rejects.toBeInstanceOf(BlobUnavailableError);
    expect((await versions.findByAssetId(asset.id)).items).toEqual([]);
  });

  test("any other failure of the row write is passed through unchanged", async () => {
    const data = bytes("db trouble");
    await upload(data);
    vi.spyOn(writes, "createAsset").mockRejectedValueOnce(new Error("D1 overloaded"));
    await expect(upload(data)).rejects.toThrow("D1 overloaded");
  });
});
