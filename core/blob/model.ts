/**
 * The content-addressed blob layer (ADR-017 §3, phase P2).
 *
 * An upload that declares its SHA-256 is stored at `blobs/{scope}/{sha256}`;
 * an undeclared one keeps its per-asset key. Extracted archives, thumbnails
 * and derived output stay under the asset's prefix either way — only the
 * original object moves. URLs do not change: `/files/{id}/…` resolves through
 * the asset or version row, and the row says where its bytes are.
 *
 * Runtime-agnostic (ADR-012): keys and rules only, no I/O.
 */
import { storageKey, versionStorageKey } from "../asset/usecase/shared";

export const BLOB_PREFIX = "blobs/";

/** Scope of a demo upload (no project): its own namespace, never a workspace's. */
export const DEMO_BLOB_SCOPE = "_demo";

/**
 * How long an unreferenced blob is kept before the cleanup cron deletes it,
 * and how old an object in `blobs/` with no ledger row must be before the
 * orphan sweep removes it (ADR-017 §5). A concurrent upload of the same bytes
 * may be about to reference a blob that has just dropped to zero; a day is
 * far longer than any direct upload takes.
 */
export const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The deduplication scope of an upload (ADR-017 §3): the workspace of the
 * asset's project; `p_{projectId}` for a project with no workspace (the
 * column is nullable); `_demo` for a demo upload, which has no project.
 *
 * The one place the rule lives. Workspace and project IDs are generated hex
 * strings, so neither prefix can collide with one.
 */
export function blobScope(project: { id: string; workspaceId?: string | null } | null): string {
  if (!project) return DEMO_BLOB_SCOPE;
  if (project.workspaceId) return project.workspaceId;
  return `p_${project.id}`;
}

/** `blobs/{scope}/{sha256}`. `sha256` is the lowercase hex the ledger stores. */
export function blobKey(scope: string, sha256: string): string {
  return `${BLOB_PREFIX}${scope}/${sha256}`;
}

/** A blob key split back into its parts, or null for anything else under `blobs/`. */
export function parseBlobKey(key: string): { scope: string; sha256: string } | null {
  if (!key.startsWith(BLOB_PREFIX)) return null;
  const rest = key.slice(BLOB_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const scope = rest.slice(0, slash);
  const sha256 = rest.slice(slash + 1);
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { scope, sha256 };
}

/** A blob as the ledger names it. */
export interface BlobRefKey {
  key: string;
  scope: string;
  sha256: string;
}

export function blobRefKey(scope: string, sha256: string): BlobRefKey {
  return { key: blobKey(scope, sha256), scope, sha256 };
}

/**
 * The storage key of a row's original bytes — the uploaded file itself, not
 * an extracted entry or a thumbnail.
 *
 * Every reader goes through here and none rebuilds a key on its own:
 *
 * - `blobKey` set → the blob layer (a declared upload, ADR-017 §3).
 * - a version row → `assets/{assetId}/v/{versionId}/{filename}` (ADR-005).
 * - an asset row  → `assets/{assetId}/{filename}`: the first upload, which
 *   has no version row.
 *
 * A version is told from an asset by its `assetId`.
 */
export function originalKey(
  row: { id: string; filename: string; assetId?: string; blobKey?: string | null },
): string {
  if (row.blobKey) return row.blobKey;
  if (row.assetId !== undefined) return versionStorageKey(row.assetId, row.id, row.filename);
  return storageKey(row.id, row.filename);
}

/** True for a key in the blob layer, which no per-asset delete may touch. */
export function isBlobKey(key: string): boolean {
  return key.startsWith(BLOB_PREFIX);
}

if (import.meta.vitest) {
  const { test, expect, describe } = import.meta.vitest;
  const SHA = "ab".repeat(32);

  describe("blobScope", () => {
    test("is the project's workspace", () => {
      expect(blobScope({ id: "p1", workspaceId: "w1" })).toBe("w1");
    });
    test("is p_{projectId} for a project with no workspace", () => {
      expect(blobScope({ id: "p1" })).toBe("p_p1");
      expect(blobScope({ id: "p1", workspaceId: null })).toBe("p_p1");
      expect(blobScope({ id: "p1", workspaceId: "" })).toBe("p_p1");
    });
    test("is _demo without a project", () => {
      expect(blobScope(null)).toBe("_demo");
    });
  });

  test("blobKey and parseBlobKey round-trip", () => {
    expect(blobKey("w1", SHA)).toBe(`blobs/w1/${SHA}`);
    expect(parseBlobKey(`blobs/w1/${SHA}`)).toEqual({ scope: "w1", sha256: SHA });
    expect(parseBlobKey(`blobs/_demo/${SHA}`)).toEqual({ scope: "_demo", sha256: SHA });
    for (const bad of ["assets/a/b", "blobs/", `blobs//${SHA}`, "blobs/w1/nothex", `blobs/w1/${SHA}/x`]) {
      expect(parseBlobKey(bad), bad).toBeNull();
    }
  });

  describe("originalKey", () => {
    test("a blob key wins for an asset and for a version", () => {
      expect(originalKey({ id: "a1", filename: "f.zip", blobKey: `blobs/w1/${SHA}` })).toBe(`blobs/w1/${SHA}`);
      expect(originalKey({ id: "v1", assetId: "a1", filename: "f.zip", blobKey: `blobs/w1/${SHA}` })).toBe(`blobs/w1/${SHA}`);
    });
    test("a version without one is under its version prefix", () => {
      expect(originalKey({ id: "v1", assetId: "a1", filename: "f.zip" })).toBe("assets/a1/v/v1/f.zip");
      expect(originalKey({ id: "v1", assetId: "a1", filename: "f.zip", blobKey: null })).toBe("assets/a1/v/v1/f.zip");
    });
    test("an asset row without one is the legacy first-upload key", () => {
      expect(originalKey({ id: "a1", filename: "f.zip" })).toBe("assets/a1/f.zip");
    });
  });
}
