import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { formatJob, localHash } from "./helpers";

test("localHash answers in the scheme of the listing's hash, so file sync can skip an unchanged file", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "serve-sync-")), "hello.txt");
  await writeFile(file, "hello");
  expect(localHash(file, "crc32:00000000")).toBe("crc32:3610a686");
  expect(localHash(file, "md5:00000000000000000000000000000000")).toBe("md5:5d41402abc4b2a76b9719d911017c592");
  expect(localHash(file, "sha256:abc")).toBeNull();
});

test("formatJob prints the failure class when the job has one", () => {
  const job = { id: "j1", assetId: "a1", type: "archive-extraction", status: "failed", createdAt: 0, updatedAt: 0 } as const;
  expect(formatJob({ ...job, failureClass: "slower-reads" })).toContain("Failure class: slower-reads");
  expect(formatJob(job)).not.toContain("Failure class");
});
