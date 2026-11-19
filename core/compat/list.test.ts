import { describe, expect, test } from "vitest";
import { compareKeys, listPage, prefixEnd, type KeyScan, type ListedPage, type ListQuery } from "./list";

function store(keys: string[]) {
  const rows = [...new Set(keys)].sort(compareKeys).map((key) => ({ key }));
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

describe("paging against a reference listing", () => {
  function reference(keys: string[], q: Partial<ListQuery>): string[] {
    const { prefix = "", delimiter = null, startOffset = null, endOffset = null } = q;
    const out: string[] = [];
    for (const k of [...new Set(keys)].sort(compareKeys)) {
      if (!k.startsWith(prefix)) continue;
      if (startOffset !== null && compareKeys(k, startOffset) < 0) continue;
      if (endOffset !== null && compareKeys(k, endOffset) >= 0) continue;
      const cut = delimiter ? k.indexOf(delimiter, prefix.length) : -1;
      const name = cut >= 0 ? k.slice(0, cut + 1) : k;
      if (out[out.length - 1] !== name) out.push(name);
    }
    return out;
  }

  async function pagedWithin(keys: string[], q: Partial<ListQuery>, maxResults: number, batch: number) {
    const seen: string[] = [];
    let pageToken: string | null = null;
    for (let pages = 0; pages <= keys.length + 1; pages++) {
      const page: ListedPage<{ key: string }> | null = await listPage(query({ ...q, maxResults, pageToken }), store(keys).scan, batch);
      expect(page!.objects.length + page!.prefixes.length).toBeLessThanOrEqual(maxResults);
      seen.push(...page!.objects.map((o) => o.key), ...page!.prefixes);
      pageToken = page!.nextPageToken;
      if (pageToken === null) return seen.sort(compareKeys);
    }
    throw new Error("pages never ended");
  }

  const cases: [string[], Partial<ListQuery>][] = [
    [["a", "b", "c"], {}],
    [["a/x", "a/y", "b", "a/z"], { delimiter: "/" }],
    [["a/x", "a/y", "b"], { prefix: "a/", delimiter: "/" }],
    [["a", "a/", "a/x"], { delimiter: "/" }],
    [["\u{1F600}", "é", "z"], {}],
  ];

  test.each(cases)("%j %j comes back whole at every page and batch size, batch 1 included", async (keys, q) => {
    for (const maxResults of [1, 2, 3]) {
      for (const batch of [1, 2, 3, 1000]) {
        expect(await pagedWithin(keys, q, maxResults, batch)).toEqual(reference(keys, q).sort(compareKeys));
      }
    }
  });

  test("seeded random buckets come back whole", async () => {
    let seed = 0x2f6b;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ["a", "b", "/", "é", "\u{1F600}", "~", "\u007f", "�", "퟿", "z"];
    const randomKey = () => Array.from({ length: 1 + rnd(5) }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let trial = 0; trial < 150; trial++) {
      const keys = Array.from({ length: rnd(25) }, randomKey);
      const q: Partial<ListQuery> = {
        prefix: rnd(2) ? "" : randomKey().slice(0, rnd(3)),
        delimiter: rnd(2) ? "/" : null,
        startOffset: rnd(4) === 0 ? randomKey() : null,
        endOffset: rnd(4) === 0 ? randomKey() : null,
      };
      const want = reference(keys, q).sort(compareKeys);
      for (const [maxResults, batch] of [[1, 1], [2, 3], [5, 2], [3, 1000]]) {
        expect(await pagedWithin(keys, q, maxResults, batch), JSON.stringify({ keys, q, maxResults, batch })).toEqual(want);
      }
    }
  });

  test("a page size below one is refused rather than answered with a null token over data", async () => {
    await expect(listPage(query({ maxResults: 0 }), store(["a"]).scan)).rejects.toThrow(RangeError);
  });
});
