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

async function walkFrom(view: TableView, query: Omit<ListQuery, "after">, after: string) {
  const pages = [];
  for (;;) {
    const page = await view.list({ ...query, after });
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
  }
}

test("ScanView matches MemoryView over random names, delimiters, limits and starting keys", async () => {
  let seed = 12345;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const alphabet = ["a", "b", "/", ".", "-", "｡", "😀", "é", "z", "0"];
  const names = new Set<string>();
  while (names.size < 300) {
    const name = Array.from({ length: 1 + random(6) }, () => alphabet[random(alphabet.length)]).join("");
    if (name.split("/").every((s) => s !== "" && s !== "." && s !== "..")) names.add(name);
  }
  const list = [...names];
  const [memory, scan] = await bothViews(writeZip(list.map((name, i) => ({ name, data: new Uint8Array([i & 0xff]) }))), "fuzz.zip");
  const pick = () => Array.from(list[random(list.length)]);
  for (let t = 0; t < 400; t++) {
    const query = {
      prefix: random(3) === 0 ? "" : pick().slice(0, 1 + random(2)).join(""),
      delimiter: ["", "/", ".", "😀"][random(4)],
      limit: [3, 7, 50][random(3)],
    };
    const after = random(2) ? "" : pick().slice(0, 1 + random(4)).join("");
    expect(await walkFrom(scan, query, after), JSON.stringify({ ...query, after })).toEqual(await walkFrom(memory, query, after));
  }
});

test("ScanView matches MemoryView once it holds more candidates than it keeps", async () => {
  const names = Array.from({ length: 3000 }, (_, i) => `${["b", "a", "c"][i % 3]}/${(i * 7919) % 3000}${i % 5 ? "/x" : ""}.t`);
  const [memory, scan] = await bothViews(writeZip(names.map((name, i) => ({ name, data: new Uint8Array([i & 0xff]) }))), "many.zip");
  for (const query of [{ prefix: "", delimiter: "", limit: 3 }, { prefix: "a/", delimiter: "/", limit: 5 }, { prefix: "", delimiter: "/", limit: 1 }]) {
    for (const after of ["", "a/1", "b/2999.t", "c/"]) {
      expect(await scan.list({ ...query, after })).toEqual(await memory.list({ ...query, after }));
    }
  }
});
