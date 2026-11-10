// Adoption of presigned uploads after the fact (ADR-017 §4, post-review
// change), against the real SQL ledger and row writes, the KV session store
// and the in-memory object store: what a project upload looks like with and
// without a blob to adopt.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSqliteClient } from "../../adapters/memory/sqlite-node";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { SqlBlobRefStore } from "../../adapters/sql/blob-refs";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import { SqlMetadataStore, SqlStorageUsageStore } from "../../adapters/sql/stores";
import { KeyValueUploadSessionStore } from "../kv/stores";
import type { PresignedUrlGenerator } from "../asset/repository";
import type { AssetMetadata } from "../asset/model";
import { createUploadSession } from "../asset/usecase/create-upload-session";
import { completeUploadSession } from "../asset/usecase/complete-upload-session";
import { uploadAsset } from "../asset/usecase/upload";
import { blobRefKey } from "./model";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const SCOPES = ["project:p1", "workspace:w1"];
const BASE = "https://serve.example";

let refs: SqlBlobRefStore;
let writes: SqlAtomicWrites;
let metadata: SqlMetadataStore;
let usage: SqlStorageUsageStore;
let storage: MemoryFileStorage;
let sessions: KeyValueUploadSessionStore;

const presigned: PresignedUrlGenerator = {
  generatePutUrl: async (key) => ({ url: `https://store.example/${key}`, headers: {} }),
  createMultipartUpload: async () => "mp",
  generateUploadPartUrl: async (key, _id, n) => `https://store.example/${key}?part=${n}`,
  completeMultipartUpload: async () => {},
  abortMultipartUpload: async () => {},
};

beforeEach(() => {
  const sql = createSqliteClient();
  refs = new SqlBlobRefStore(sql);
  writes = new SqlAtomicWrites(sql);
  metadata = new SqlMetadataStore(sql);
  usage = new SqlStorageUsageStore(sql);
  storage = new MemoryFileStorage();
  sessions = new KeyValueUploadSessionStore(new MemoryKeyValue());
});

/** A project upload through a single-PUT session: create, the client's PUT, complete. */
async function sessionUpload(body: Uint8Array<ArrayBuffer>, filename = "data.txt") {
  const created = await createUploadSession(sessions, presigned, {
    filename, contentType: "text/plain", size: body.byteLength, sha256: sha256(body), contentEncoding: "identity",
  }, 3600, { projectId: "p1", blobScope: "w1" });
  const key = new URL((created as { url: string }).url).pathname.slice(1);
  await storage.put(key, new Blob([body]).stream(), "text/plain", body.byteLength, { sha256: sha256(body) });
  const result = await completeUploadSession(sessions, writes, metadata, storage, presigned, created.uploadId, 3600, BASE, undefined, {
    projectId: "p1", usageScopes: SCOPES, blobRefs: refs,
  });
  return { created, result: result!, key };
}

function withoutIdentity(asset: AssetMetadata) {
  const { id: _i, createdAt: _c, blobKey: _b, ...rest } = asset;
  return rest;
}

describe("completeUploadSession with adoption", () => {
  test("usage counters, the response and the row's fields move identically with and without adoption", async () => {
    const body = bytes("the same bytes, counted twice");

    const before = await usage.get("workspace:w1");
    const plain = await sessionUpload(body);
    const afterPlain = await usage.get("workspace:w1");

    // The bytes enter the blob layer through a direct upload in the same workspace.
    await uploadAsset(writes, storage, { name: "held.txt", type: "text/plain", body: new Blob([body]).stream(), size: body.byteLength, sha256: sha256(body) },
      3600, BASE, { projectId: "p1", usageScopes: SCOPES, blob: { refs, scope: "w1" } });

    const beforeAdopted = await usage.get("workspace:w1");
    const adopted = await sessionUpload(body);
    const afterAdopted = await usage.get("workspace:w1");

    const delta = (a: typeof before, b: typeof before) => ({
      totalSize: (b?.totalSize ?? 0) - (a?.totalSize ?? 0), assetCount: (b?.assetCount ?? 0) - (a?.assetCount ?? 0),
    });
    expect(delta(beforeAdopted, afterAdopted)).toEqual(delta(before, afterPlain));
    expect(delta(before, afterPlain)).toEqual({ totalSize: body.byteLength, assetCount: 1 });

    expect(Object.keys(adopted.result).sort()).toEqual(Object.keys(plain.result).sort());
    expect(withoutIdentity(adopted.result.asset)).toEqual(withoutIdentity(plain.result.asset));
    expect(withoutIdentity((await metadata.find(adopted.created.uploadId))!))
      .toEqual(withoutIdentity((await metadata.find(plain.created.uploadId))!));

    // Only where the bytes live differs.
    const blob = blobRefKey("w1", sha256(body)).key;
    expect(await metadata.find(plain.created.uploadId)).not.toHaveProperty("blobKey");
    expect((await metadata.find(adopted.created.uploadId))?.blobKey).toBe(blob);
    expect(await refs.find(blob)).toMatchObject({ refCount: 2 });
    expect(await refs.find(adopted.key)).toMatchObject({ state: "retired", refCount: 0 });
    expect(await refs.find(plain.key)).toBeNull();
  });

  test("adoption adds no store round trip to the request: the classic object is left for the sweep", async () => {
    const body = bytes("no inline delete");
    await uploadAsset(writes, storage, { name: "held.txt", type: "text/plain", body: new Blob([body]).stream(), size: body.byteLength, sha256: sha256(body) },
      3600, BASE, { projectId: "p1", usageScopes: SCOPES, blob: { refs, scope: "w1" } });
    const del = vi.spyOn(storage, "delete");
    const { key } = await sessionUpload(body);
    expect(del).not.toHaveBeenCalled();
    expect(await storage.head(key)).not.toBeNull();
  });

  test("a store-reported mismatch is still 422 and keeps nothing, whatever the scope holds", async () => {
    const body = bytes("held");
    await uploadAsset(writes, storage, { name: "held.txt", type: "text/plain", body: new Blob([body]).stream(), size: body.byteLength, sha256: sha256(body) },
      3600, BASE, { projectId: "p1", usageScopes: SCOPES, blob: { refs, scope: "w1" } });
    const created = await createUploadSession(sessions, presigned, {
      filename: "x.txt", contentType: "text/plain", size: body.byteLength, sha256: sha256(body),
    }, 3600, { projectId: "p1", blobScope: "w1" });
    const key = new URL((created as { url: string }).url).pathname.slice(1);
    // The store kept other bytes (and their hash) than the ones declared.
    await storage.put(key, new Blob(["other"]).stream(), "text/plain", 5);
    await expect(completeUploadSession(sessions, writes, metadata, storage, presigned, created.uploadId, 3600, BASE, undefined, {
      projectId: "p1", usageScopes: SCOPES, blobRefs: refs,
    })).rejects.toMatchObject({ name: "ChecksumMismatchError" });
    expect(await storage.head(key)).toBeNull();
    expect(await refs.find(blobRefKey("w1", sha256(body)).key)).toMatchObject({ refCount: 1 });
  });
});
