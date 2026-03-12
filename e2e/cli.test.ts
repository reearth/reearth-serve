import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
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
});
