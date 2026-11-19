import { describe, expect, test } from "vitest";
import { compareKeys, listPage, prefixEnd, type KeyScan, type ListedPage, type ListQuery } from "./list";

function store(keys: string[]) {
  const rows = [...keys].sort(compareKeys).map((key) => ({ key }));
  const calls: string[] = [];
  const scan: KeyScan<{ key: string }> = async (from, until, limit) => {
    calls.push(from);
    return rows.filter((r) => compareKeys(r.key, from) >= 0 && (until === null || compareKeys(r.key, until) < 0)).slice(0, limit);
  };
  return { scan, calls };
}

const query = (q: Partial<ListQuery> = {}): ListQuery => ({
  prefix: "", delimiter: null, startOffset: null, endOffset: null, pageToken: null, maxResults: 1000, ...q,
});

async function names(keys: string[], q: Partial<ListQuery>, batch?: number) {
  const page = await listPage(query(q), store(keys).scan, batch);
  return { objects: page!.objects.map((o) => o.key), prefixes: page!.prefixes, next: page!.nextPageToken };
}

async function everything(keys: string[], q: Partial<ListQuery>, batch?: number) {
  const seen: string[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  do {
    const page: ListedPage<{ key: string }> | null = await listPage(query({ ...q, pageToken }), store(keys).scan, batch);
    seen.push(...page!.objects.map((o) => o.key), ...page!.prefixes);
    pageToken = page!.nextPageToken;
    pages++;
  } while (pageToken);
  return { seen, pages };
}

describe("delimiter", () => {
  const keys = ["a.txt", "assets/ab/1/x.txt", "assets/ab/1/y.txt", "assets/ab/2/z.txt", "assets/cd/w.txt", "b/c"];

  test("folds keys below the prefix into common prefixes, once each", async () => {
    expect(await names(keys, { delimiter: "/" })).toEqual({ objects: ["a.txt"], prefixes: ["assets/", "b/"], next: null });
    expect(await names(keys, { prefix: "assets/ab/", delimiter: "/" }))
      .toEqual({ objects: [], prefixes: ["assets/ab/1/", "assets/ab/2/"], next: null });
    expect(await names(keys, { prefix: "assets/ab/1/", delimiter: "/" }))
      .toEqual({ objects: ["assets/ab/1/x.txt", "assets/ab/1/y.txt"], prefixes: [], next: null });
  });

  test("a prefix that ends mid-segment folds at the next delimiter", async () => {
    expect(await names(keys, { prefix: "assets/a", delimiter: "/" })).toEqual({ objects: [], prefixes: ["assets/ab/"], next: null });
  });

  test("without a delimiter every key under the prefix is listed", async () => {
    expect((await names(keys, { prefix: "assets/" })).objects).toEqual(keys.slice(1, 5));
  });

  test("a folded prefix that spans a scan batch is still emitted once", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `dir/${String(i).padStart(3, "0")}`).concat(["z"]);
    expect(await names(many, { delimiter: "/" }, 4)).toEqual({ objects: ["z"], prefixes: ["dir/"], next: null });
  });
});

describe("paging", () => {
  const keys = Array.from({ length: 1050 }, (_, i) => `k/${String(i).padStart(5, "0")}`);

  test("pages across a boundary return every key once, in order", async () => {
    const { seen, pages } = await everything(keys, { maxResults: 1000 });
    expect(seen).toEqual(keys);
    expect(pages).toBe(2);
  });

  test("small pages and small scan batches agree", async () => {
    const { seen, pages } = await everything(keys, { maxResults: 7 }, 3);
    expect(seen).toEqual(keys);
    expect(pages).toBe(150);
  });

  test("a full last page has no next token", async () => {
    expect((await names(keys.slice(0, 10), { maxResults: 10 })).next).toBeNull();
  });

  test("a page that ends on a common prefix resumes after it", async () => {
    const mixed = ["a/1", "a/2", "b", "c/1", "d"];
    const first = await names(mixed, { delimiter: "/", maxResults: 1 });
    expect(first.prefixes).toEqual(["a/"]);
    const { seen } = await everything(mixed, { delimiter: "/", maxResults: 1 });
    expect(seen).toEqual(["a/", "b", "c/", "d"]);
  });

  test("a token that was not issued here is refused", async () => {
    expect(await listPage(query({ pageToken: "bm90LWEtdG9rZW4" }), store(keys).scan)).toBeNull();
    expect(await listPage(query({ pageToken: "%%%" }), store(keys).scan)).toBeNull();
  });
});

describe("offsets", () => {
  const keys = ["a", "b", "c", "d", "e"];

  test("startOffset is inclusive and endOffset exclusive", async () => {
    expect((await names(keys, { startOffset: "b", endOffset: "d" })).objects).toEqual(["b", "c"]);
  });

  test("offsets combine with a prefix", async () => {
    expect((await names(["p/a", "p/b", "p/c", "q"], { prefix: "p/", startOffset: "p/b" })).objects).toEqual(["p/b", "p/c"]);
    expect((await names(["p/a", "p/b", "q"], { prefix: "p/", endOffset: "z" })).objects).toEqual(["p/a", "p/b"]);
  });
});

describe("key order", () => {
  test("is UTF-8 byte order, as SQLite's BINARY collation", () => {
    expect(compareKeys("￿", "\u{1f600}")).toBeLessThan(0);
    expect("￿" < "\u{1f600}").toBe(false);
  });

  test("prefixEnd bounds every key under the prefix", () => {
    expect(prefixEnd("assets/")).toBe("assets0");
    expect(prefixEnd("")).toBeNull();
  });
});
