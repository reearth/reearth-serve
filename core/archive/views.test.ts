import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { buildView, type ArchiveSource } from "./reader";
import { writeZip } from "./testing";
import type { ListQuery, TableView } from "./views";

const FIXTURES = new URL("../../scripts/fixtures/zip/data/", import.meta.url);

async function bothViews(bytes: Uint8Array, filename: string): Promise<[TableView, TableView]> {
  const storage = new MemoryFileStorage();
  const source: ArchiveSource = { key: filename, size: bytes.byteLength, filename };
  await storage.put(source.key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  const memory = await buildView(storage, source, () => {});
  const scan = await buildView(storage, source, () => {}, 0);
  if (!memory.ok || !scan.ok) throw new Error("fixture did not open");
  return [memory.view, scan.view];
}

async function walk(view: TableView, query: Omit<ListQuery, "after">) {
  const pages = [];
  let after = "";
  for (;;) {
    const page = await view.list({ ...query, after });
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
  }
}

const QUERIES: Omit<ListQuery, "after">[] = [
  { prefix: "", delimiter: "", limit: 1 },
  { prefix: "", delimiter: "", limit: 1000 },
  { prefix: "", delimiter: "/", limit: 1 },
  { prefix: "", delimiter: "/", limit: 3 },
  { prefix: "a/", delimiter: "/", limit: 2 },
  { prefix: "d00", delimiter: "/", limit: 2 },
  { prefix: "日本語/", delimiter: "/", limit: 1 },
];

const archives: [string, Uint8Array][] = [
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => [f, new Uint8Array(readFileSync(new URL(f, FIXTURES)))] as [string, Uint8Array]),
  [
    "nested.zip",
    writeZip(
      Array.from({ length: 300 }, (_, i) => ({
        name: `d${String(i % 7).padStart(3, "0")}/${i % 3 ? "x/" : ""}f${String(i).padStart(5, "0")}.txt`,
        data: new Uint8Array([i & 0xff]),
      })),
    ),
  ],
];

describe("ScanView answers exactly what MemoryView answers", () => {
  test.each(archives)("%s", async (filename, bytes) => {
    const [memory, scan] = await bothViews(bytes, filename);
    expect(scan.rootPrefix).toBe(memory.rootPrefix);
    for (const query of QUERIES) {
      expect(await walk(scan, query)).toEqual(await walk(memory, query));
    }
    const first = (await memory.list({ prefix: "", delimiter: "", after: "", limit: 1 })).entries[0];
    if (first) expect(await scan.find(first.path)).toEqual(await memory.find(first.path));
    expect(await scan.find("no/such/entry")).toBeNull();
  });
});
