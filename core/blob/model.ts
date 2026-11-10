/**
 * The content-addressed blob layer (ADR-017 §3, phase P2).
 *
 * A direct upload that declares its SHA-256 is stored at
 * `blobs/{scope}/{sha256}`; an undeclared one keeps its per-asset key. A
 * presigned upload always goes to its per-asset key (its URL names the key,
 * so the key must not depend on what the scope holds) and is switched to the
 * scope's blob afterwards when one with the same bytes exists ("adoption",
 * core/blob/adoption.ts). Extracted archives, thumbnails
 * and derived output stay under the asset's prefix either way — only the
 * original object moves. URLs do not change: `/files/{id}/…` resolves through
 * the asset or version row, and the row says where its bytes are.
 *
 * Runtime-agnostic (ADR-012): keys and rules only, no I/O.
 */
import { storageKey, versionStorageKey } from "../asset/usecase/shared";

export const BLOB_PREFIX = "blobs/";

/**
 * Prefix of a demo upload's scope (no project): `_demo_{sessionId}`, one
 * namespace per anonymous session, never a workspace's. A scope shared by
 * every anonymous caller would let one of them obtain another's demo file by
 * its hash, so demo bytes are deduplicated only within the session that
 * uploaded them (ADR-017 §3, post-review change).
 *
 * `_demo` on its own is the scope P2 gave every demo upload. Nothing writes it
 * any more, but rows and objects under it may still exist on deployments that
 * ran P2–P5; they keep working (the row records its key) and are swept like
 * any other blob once unreferenced.
 */
export const DEMO_BLOB_SCOPE_PREFIX = "_demo_";

/** Session IDs as the session middleware mints them. Anything else gets no demo scope. */
const DEMO_SESSION_ID = /^[0-9a-f]{1,64}$/;

/**
 * How long an unreferenced blob is kept before the cleanup cron deletes it,
 * and how old an object in `blobs/` with no ledger row must be before the
 * orphan sweep removes it (ADR-017 §5). A concurrent upload of the same bytes
 * may be about to reference a blob that has just dropped to zero; a day is
 * far longer than any direct upload takes.
 *
 * The same grace applies to the classic object of an upload whose row was
 * switched to an existing blob after the fact (`retired`, see
 * `BlobAttach.retire`): a reader that resolved the classic key just before
 * the switch — a `/files` response in flight, an extraction launched with
 * that key — keeps reading it for a day.
 */
export const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Clock skew allowed between the Worker that looked a blob up and the one
 * that released its last reference, which stamps `zero_since` with its own
 * clock. See `stillAttachable` (core/blob/usecase.ts).
 */
export const ATTACH_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The oldest `zero_since` with which a blob found reusable at `since` may
 * still be attached to: it lost its last reference after the lookup (give or
 * take clock skew), so no sweep can have taken it yet.
 */
export function attachThreshold(since: number): number {
  return since - ATTACH_CLOCK_SKEW_MS;
}

/**
 * The deduplication scope of an upload (ADR-017 §3): the workspace of the
 * asset's project; `p_{projectId}` for a project with no workspace (the
 * column is nullable); `_demo_{sessionId}` for a demo upload, which has no
 * project. Null when a demo upload has no usable session ID: such an upload
 * stays out of the blob layer and is stored at its classic key.
 *
 * The one place the rule lives. Workspace and project IDs are generated hex
 * strings and session IDs are hex, so `p_…` and `_demo_…` cannot collide with
 * a workspace ID or with each other, and every scope is a single path segment
 * of safe characters.
 */
export function blobScope(
  project: { id: string; workspaceId?: string | null } | null,
  sessionId?: string | null,
): string | null {
  if (!project) return sessionId && DEMO_SESSION_ID.test(sessionId) ? `${DEMO_BLOB_SCOPE_PREFIX}${sessionId}` : null;
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
  /** The object key: `blobs/{scope}/{sha256}`, or a classic key for a `retired` row. */
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
 *
 * An asset row's `blobKey` may be set once after the row was written, when a
 * presigned upload's classic object is replaced by the scope's identical blob
 * (adoption, core/blob/adoption.ts). So the key is resolved from the row on
 * every request, never remembered across requests; the classic object stays
 * readable for `BLOB_GRACE_MS` after the switch for readers that resolved it
 * just before.
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
    test("is _demo_{sessionId} without a project: one scope per anonymous session", () => {
      expect(blobScope(null, "0123456789abcdef")).toBe("_demo_0123456789abcdef");
      expect(blobScope(null, "fedcba9876543210")).not.toBe(blobScope(null, "0123456789abcdef"));
    });
    test("is null for a demo upload without a well-formed session ID", () => {
      expect(blobScope(null)).toBeNull();
      expect(blobScope(null, null)).toBeNull();
      expect(blobScope(null, "")).toBeNull();
      expect(blobScope(null, "../x")).toBeNull();
      expect(blobScope(null, "a/b")).toBeNull();
    });
  });

  test("blobKey and parseBlobKey round-trip", () => {
    expect(blobKey("w1", SHA)).toBe(`blobs/w1/${SHA}`);
    expect(parseBlobKey(`blobs/w1/${SHA}`)).toEqual({ scope: "w1", sha256: SHA });
    expect(parseBlobKey(`blobs/_demo/${SHA}`)).toEqual({ scope: "_demo", sha256: SHA });
    const demo = blobScope(null, "0123456789abcdef")!;
    expect(parseBlobKey(blobKey(demo, SHA))).toEqual({ scope: "_demo_0123456789abcdef", sha256: SHA });
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
