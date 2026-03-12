import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE, rewriteUrl } from "./helpers";

describe("CLI", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    tmpDir = mkdtempSync(join(tmpdir(), "serve-e2e-"));
    tmpFile = join(tmpDir, "sample.txt");
    writeFileSync(tmpFile, "cli test content");
  });

  test("CLI upload outputs a URL that works", async () => {
    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} upload "${tmpFile}"`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toContain("/files/");
    expect(out).toContain("sample.txt");

    const res = await fetch(rewriteUrl(out));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("cli test content");
  });

  test("CLI upload --json outputs JSON", () => {
    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
      { encoding: "utf-8" },
    ).trim();
    const parsed = JSON.parse(out);
    expect(parsed.asset).toBeDefined();
    expect(parsed.url).toContain("/files/");
  });

  test("CLI asset create works same as upload", async () => {
    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} asset create "${tmpFile}"`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toContain("/files/");
    expect(out).toContain("sample.txt");
  });

  test("CLI asset show returns metadata", async () => {
    // Upload first
    const uploadOut = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
      { encoding: "utf-8" },
    ).trim();
    const { asset } = JSON.parse(uploadOut);

    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} asset show ${asset.id}`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toContain(asset.id);
    expect(out).toContain("sample.txt");
  });

  test("CLI asset delete removes asset", async () => {
    const uploadOut = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
      { encoding: "utf-8" },
    ).trim();
    const { asset } = JSON.parse(uploadOut);

    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} asset delete ${asset.id}`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toContain("Deleted");
  });

  test("CLI health checks server", () => {
    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} health`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toBe("OK");
  });

  test("CLI --help exits 0", () => {
    const out = execSync("npx tsx cli/index.ts --help", {
      encoding: "utf-8",
    }).trim();
    expect(out).toContain("Usage:");
  });

  test("CLI upload --help shows --direct flag", () => {
    const out = execSync("npx tsx cli/index.ts upload --help", {
      encoding: "utf-8",
    }).trim();
    expect(out).toContain("--direct");
  });

  test("CLI upload with non-existent file exits with error", () => {
    expect(() => {
      execSync("npx tsx cli/index.ts upload /tmp/does_not_exist_12345.bin", {
        encoding: "utf-8",
        stdio: "pipe",
      });
    }).toThrow();
  });

  // --- file ls / cp / sync ---

  describe("file ls", () => {
    test("file ls lists uploaded file", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file ls ${asset.id}`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toBe("sample.txt");
    });

    test("file ls --json outputs NDJSON", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json file ls ${asset.id}`,
        { encoding: "utf-8" },
      ).trim();
      const entry = JSON.parse(out);
      expect(entry.path).toBe("sample.txt");
      expect(entry.size).toBeGreaterThan(0);
    });

    test("file ls -l shows detailed output", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file ls -l ${asset.id}`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("sample.txt");
      expect(out).toContain("text/plain");
      expect(out).toContain("1 file(s)");
    });

    test("file ls with prefix filters results", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      // Matching prefix
      const out1 = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file ls ${asset.id} sample`,
        { encoding: "utf-8" },
      ).trim();
      expect(out1).toBe("sample.txt");

      // Non-matching prefix
      const out2 = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file ls ${asset.id} nonexistent`,
        { encoding: "utf-8" },
      ).trim();
      expect(out2).toContain("No files");
    });
  });

  describe("file cp", () => {
    test("file cp downloads a single file", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const dest = join(mkdtempSync(join(tmpdir(), "serve-cp-")), "downloaded.txt");
      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file cp ${asset.id} "${dest}"`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("Downloaded");
      expect(readFileSync(dest, "utf-8")).toBe("cli test content");
    });

    test("file cp with path downloads specific file", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const dest = join(mkdtempSync(join(tmpdir(), "serve-cp-")), "out.txt");
      execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file cp ${asset.id}:sample.txt "${dest}"`,
        { encoding: "utf-8" },
      );
      expect(readFileSync(dest, "utf-8")).toBe("cli test content");
    });

    test("file cp without -f fails if dest exists", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-cp-"));
      const dest = join(destDir, "existing.txt");
      writeFileSync(dest, "old content");

      expect(() => {
        execSync(
          `npx tsx cli/index.ts --endpoint ${BASE} file cp ${asset.id} "${dest}"`,
          { encoding: "utf-8", stdio: "pipe" },
        );
      }).toThrow();
      // Original content should be preserved
      expect(readFileSync(dest, "utf-8")).toBe("old content");
    });

    test("file cp -f overwrites existing file", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-cp-"));
      const dest = join(destDir, "existing.txt");
      writeFileSync(dest, "old content");

      execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file cp -f ${asset.id} "${dest}"`,
        { encoding: "utf-8" },
      );
      expect(readFileSync(dest, "utf-8")).toBe("cli test content");
    });
  });

  describe("file sync", () => {
    test("file sync downloads files to directory", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-sync-"));
      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file sync ${asset.id} "${destDir}"`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("Done");
      expect(out).toContain("downloaded");

      const downloaded = join(destDir, "sample.txt");
      expect(existsSync(downloaded)).toBe(true);
      expect(readFileSync(downloaded, "utf-8")).toBe("cli test content");
    });

    test("file sync skips unchanged files (hash match)", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-sync-"));

      // First sync
      execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file sync ${asset.id} "${destDir}"`,
        { encoding: "utf-8" },
      );

      // Second sync — should skip (unchanged)
      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file sync ${asset.id} "${destDir}"`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("unchanged");
      expect(out).not.toContain("downloaded");
    });

    test("file sync --delete removes extra local files", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-sync-"));

      // Create an extra local file that doesn't exist in the remote
      const extraFile = join(destDir, "extra.txt");
      writeFileSync(extraFile, "should be deleted");

      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} file sync --delete ${asset.id} "${destDir}"`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("deleted");
      expect(existsSync(extraFile)).toBe(false);

      // The synced file should still exist
      expect(existsSync(join(destDir, "sample.txt"))).toBe(true);
    });

    test("file sync --json outputs structured result", () => {
      const uploadOut = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json upload "${tmpFile}"`,
        { encoding: "utf-8" },
      ).trim();
      const { asset } = JSON.parse(uploadOut);

      const destDir = mkdtempSync(join(tmpdir(), "serve-sync-"));
      const out = execSync(
        `npx tsx cli/index.ts --endpoint ${BASE} --json file sync ${asset.id} "${destDir}"`,
        { encoding: "utf-8" },
      ).trim();
      const result = JSON.parse(out);
      expect(result.ok).toBe(true);
      expect(result.downloaded).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });
});
