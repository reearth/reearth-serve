import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { localHash } from "./helpers";

test("localHash answers in the scheme of the listing's hash, so file sync can skip an unchanged file", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "serve-sync-")), "hello.txt");
  await writeFile(file, "hello");
  expect(localHash(file, "crc32:00000000")).toBe("crc32:3610a686");
  expect(localHash(file, "md5:00000000000000000000000000000000")).toBe("md5:5d41402abc4b2a76b9719d911017c592");
  expect(localHash(file, "sha256:abc")).toBeNull();
});
