import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASE, MOCK_OIDC, signToken } from "./helpers";

// Auto-detect if mock OIDC server is reachable
let mockOidcAvailable = false;
try {
  const res = await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`);
  mockOidcAvailable = res.ok;
} catch {
  // not reachable
}

// The CLI reads its credentials from REEARTH_SERVE_CONFIG_DIR. Use a throwaway
// directory: writing into the developer's real ~/.config/reearth-serve leaked
// this suite's access token into every other e2e test that shells out to the
// CLI concurrently (see e2e/compression.test.ts).
let configDir: string;
let CREDENTIALS_FILE: string;
let CONFIG_FILE: string;

function cli(args: string): string {
  return execSync(
    `npx tsx cli/index.ts --endpoint ${BASE} ${args}`,
    { encoding: "utf-8", env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir } },
  ).trim();
}

function cliJson(args: string): unknown {
  return JSON.parse(cli(`--json ${args}`));
}

describe("CLI project commands", { skip: !mockOidcAvailable }, () => {
  let token: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    token = await signToken({ sub: "cli-proj-user" });

    configDir = mkdtempSync(join(tmpdir(), "serve-e2e-proj-config-"));
    CREDENTIALS_FILE = join(configDir, "credentials.json");
    CONFIG_FILE = join(configDir, "config.json");

    // Write test credentials
    writeFileSync(CREDENTIALS_FILE, JSON.stringify({
      accessToken: token,
      expiresAt: Date.now() + 3600_000,
    }), { mode: 0o600 });

    // Clear default project
    writeFileSync(CONFIG_FILE, JSON.stringify({}));
  });

  test("project list (empty)", () => {
    const out = cli("project list");
    expect(out).toContain("No projects");
  });

  test("project create", () => {
    const out = cli("project create test-cli-project");
    expect(out).toContain("test-cli-project");
    expect(out).toContain("ID:");
  });

  test("project create --json", () => {
    const data = cliJson("project create json-project") as { project: { id: string; name: string } };
    expect(data.project.name).toBe("json-project");
    expect(data.project.id).toBeDefined();
  });

  test("project list shows created projects", () => {
    const out = cli("project list");
    expect(out).toContain("test-cli-project");
    expect(out).toContain("json-project");
  });

  test("project list --json", () => {
    const data = cliJson("project list") as { projects: { name: string }[] };
    expect(data.projects.length).toBeGreaterThanOrEqual(2);
  });

  test("project show <id>", () => {
    const listData = cliJson("project list") as { projects: { id: string; name: string }[] };
    const p = listData.projects.find((p) => p.name === "test-cli-project")!;
    const out = cli(`project show ${p.id}`);
    expect(out).toContain(p.id);
    expect(out).toContain("test-cli-project");
  });

  test("project use sets default project", () => {
    const listData = cliJson("project list") as { projects: { id: string; name: string }[] };
    const p = listData.projects.find((p) => p.name === "test-cli-project")!;

    const out = cli(`project use ${p.id}`);
    expect(out).toContain("Default project set");
    expect(out).toContain("test-cli-project");
  });

  test("project show (defaults to current project)", () => {
    const out = cli("project show");
    expect(out).toContain("test-cli-project");
  });

  test("project list marks default", () => {
    const out = cli("project list");
    expect(out).toContain("(default)");
  });

  test("project delete", () => {
    const listData = cliJson("project list") as { projects: { id: string; name: string }[] };
    for (const p of listData.projects) {
      const out = cli(`project delete ${p.id}`);
      expect(out).toContain("Deleted");
    }
    const afterList = cli("project list");
    expect(afterList).toContain("No projects");
  });
});
