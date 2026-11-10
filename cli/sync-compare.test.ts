import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry } from "../shared/api";
import { isUnchanged } from "./sync-compare";

const content = new TextEncoder().encode("local bytes");
const sha = createHash("sha256").update(content).digest("hex");
const md5 = `md5:${createHash("md5").update(content).digest("hex")}`;

async function localFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "cli-sync-")), "f.bin");
  await writeFile(path, content);
  return path;
}

const base: FileEntry = { path: "f.bin", size: content.byteLength, contentType: "application/octet-stream" };

describe("isUnchanged", () => {
  test("a missing local file is changed", async () => {
    expect(await isUnchanged({ ...base, sha256: sha, integrity: "verified" }, "/nonexistent/f.bin")).toBe(false);
  });

  test("a verified SHA-256 decides, over a stale ETag", async () => {
    const path = await localFile();
    expect(await isUnchanged({ ...base, sha256: sha, integrity: "verified", hash: "md5:stale" }, path)).toBe(true);
    expect(await isUnchanged({ ...base, sha256: "0".repeat(64), integrity: "verified", hash: md5 }, path)).toBe(false);
  });

  test("a size mismatch is changed without hashing", async () => {
    const path = await localFile();
    expect(await isUnchanged({ ...base, size: 999, sha256: sha, integrity: "verified" }, path)).toBe(false);
  });

  test("a pending hash, or a gzip-stored one, falls back to the MD5", async () => {
    const path = await localFile();
    expect(await isUnchanged({ ...base, sha256: "0".repeat(64), integrity: "pending", hash: md5 }, path)).toBe(true);
    expect(await isUnchanged({ ...base, sha256: "0".repeat(64), integrity: "verified", contentEncoding: "gzip", hash: md5 }, path)).toBe(true);
  });

  test("with no hash at all, size decides", async () => {
    const path = await localFile();
    expect(await isUnchanged(base, path)).toBe(true);
    expect(await isUnchanged({ ...base, size: 1 }, path)).toBe(false);
  });
});
