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
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    tmpDir = mkdtempSync(join(tmpdir(), "serve-e2e-"));
    tmpFile = join(tmpDir, "sample.txt");
    writeFileSync(tmpFile, "cli test content");
  });

  test("CLI outputs a URL that works", async () => {
    const out = execSync(
      `npx tsx cli/index.ts "${tmpFile}" --endpoint ${BASE}`,
      { encoding: "utf-8" },
    ).trim();
    expect(out).toContain("/files/");
    expect(out).toContain("sample.txt");

    const res = await fetch(rewriteUrl(out));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("cli test content");
  });

  test("CLI --json outputs JSON", () => {
    const out = execSync(
      `npx tsx cli/index.ts "${tmpFile}" --endpoint ${BASE} --json`,
      { encoding: "utf-8" },
    ).trim();
    const parsed = JSON.parse(out);
    expect(parsed.asset).toBeDefined();
    expect(parsed.url).toContain("/files/");
  });

  test("CLI --help exits 0", () => {
    const out = execSync("npx tsx cli/index.ts --help", {
      encoding: "utf-8",
    }).trim();
    expect(out).toContain("Usage:");
  });

  test("CLI --help shows --direct flag", () => {
    const out = execSync("npx tsx cli/index.ts --help", {
      encoding: "utf-8",
    }).trim();
    expect(out).toContain("--direct");
  });

  test("CLI with non-existent file exits with error", () => {
    expect(() => {
      execSync("npx tsx cli/index.ts /tmp/does_not_exist_12345.bin", {
        encoding: "utf-8",
        stdio: "pipe",
      });
    }).toThrow();
  });
});
