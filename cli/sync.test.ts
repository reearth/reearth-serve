import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { FileEntry } from "../shared/api";

const ASSET = "a1b2c3d4e5f60718";

let registerFileCommands: typeof import("./file").registerFileCommands;

beforeAll(async () => {
  process.env.REEARTH_SERVE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "serve-sync-config-"));
  ({ registerFileCommands } = await import("./file"));
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

/** A server whose listing is `entries` and whose /files answers from `bodies`, 404 for anything else. */
async function serve(entries: FileEntry[], bodies: Record<string, string>): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === `/api/v1/assets/${ASSET}/files`) {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.end(entries.map((e) => JSON.stringify(e) + "\n").join(""));
      return;
    }
    const name = decodeURIComponent(req.url!.slice(`/files/${ASSET}/`.length));
    if (name in bodies) res.end(bodies[name]);
    else res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function sync(endpoint: string, dest: string, json = false): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const program = new Command().option("--endpoint <url>").option("--json", "", false).exitOverride();
  registerFileCommands(program, program.command("file"));
  await program.parseAsync(["--endpoint", endpoint, ...(json ? ["--json"] : []), "file", "sync", ASSET, dest], { from: "user" });
  return logs;
}

const crc = (hex: string) => `crc32:${hex}`;

test("an entry /files cannot serve yet is reported as not yet available, and the rest still sync", async () => {
  const endpoint = await serve(
    [
      { path: "ready.txt", size: 5, contentType: "text/plain", hash: crc("3610a686") },
      { path: "later.txt", size: 3, contentType: "text/plain", hash: crc("00000000") },
    ],
    { "ready.txt": "hello" },
  );
  const dest = mkdtempSync(join(tmpdir(), "serve-sync-"));
  const logs = await sync(endpoint, dest);
  expect(readFileSync(join(dest, "ready.txt"), "utf8")).toBe("hello");
  expect(existsSync(join(dest, "later.txt"))).toBe(false);
  expect(logs.join("\n")).toContain("1 downloaded, 1 file(s) not yet available (extraction may be in progress)");
});

test("--json counts the entries not yet available", async () => {
  const endpoint = await serve([{ path: "later.txt", size: 3, contentType: "text/plain", hash: crc("00000000") }], {});
  const dest = mkdtempSync(join(tmpdir(), "serve-sync-"));
  const logs = await sync(endpoint, dest, true);
  expect(JSON.parse(logs[0])).toMatchObject({ ok: true, downloaded: 0, unavailable: 1 });
});

test("a local file with the listed CRC-32 but a different size is downloaded again", async () => {
  const endpoint = await serve([{ path: "f.txt", size: 9, contentType: "text/plain", hash: crc("3610a686") }], { "f.txt": "hello2026" });
  const dest = mkdtempSync(join(tmpdir(), "serve-sync-"));
  writeFileSync(join(dest, "f.txt"), "hello");
  await sync(endpoint, dest);
  expect(readFileSync(join(dest, "f.txt"), "utf8")).toBe("hello2026");
});

test("a local file with the listed CRC-32 and size is left alone", async () => {
  const endpoint = await serve([{ path: "f.txt", size: 5, contentType: "text/plain", hash: crc("3610a686") }], {});
  const dest = mkdtempSync(join(tmpdir(), "serve-sync-"));
  writeFileSync(join(dest, "f.txt"), "hello");
  const logs = await sync(endpoint, dest);
  expect(logs.join("\n")).toContain("Done: 1 unchanged");
});
