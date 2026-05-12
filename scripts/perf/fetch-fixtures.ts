#!/usr/bin/env tsx
// Build a size-sorted fixture list of PLATEAU citygml.zip URLs.
//
// Usage:
//   npm run cli -- exec scripts/perf/fetch-fixtures.ts        # default
//   tsx scripts/perf/fetch-fixtures.ts --out fixtures.json
//
// Output: JSON array, each item:
//   { id, city, pref, year, url, size, bucket }
// sorted by size ascending.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CATALOG_URL = "https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets";
const HEAD_CONCURRENCY = 16;
const HEAD_TIMEOUT_MS = 15_000;

type CityGmlEntry = {
  id: string;
  pref: string;
  pref_code: string;
  city: string;
  city_code: string;
  url: string;
  year: number;
  registration_year?: number;
  spec?: string;
};

type Fixture = {
  id: string;
  city: string;
  pref: string;
  year: number;
  url: string;
  size: number;
  bucket: Bucket;
};

type Bucket = "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL";

const BUCKETS: { name: Bucket; max: number }[] = [
  { name: "XS", max: 50 * 1024 * 1024 },           //   ~50 MB
  { name: "S", max: 300 * 1024 * 1024 },           //  ~300 MB
  { name: "M", max: 1024 * 1024 * 1024 },          //   ~1 GB
  { name: "L", max: 5 * 1024 * 1024 * 1024 },      //   ~5 GB
  { name: "XL", max: 15 * 1024 * 1024 * 1024 },    //  ~15 GB
  { name: "XXL", max: 50 * 1024 * 1024 * 1024 },   //  ~50 GB
  { name: "XXXL", max: Infinity },                  //   over
];

function bucketFor(size: number): Bucket {
  return BUCKETS.find((b) => size <= b.max)!.name;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function headSize(url: string): Promise<number | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ac.signal });
    if (!res.ok) return null;
    const cl = res.headers.get("content-length");
    return cl ? Number(cl) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseArgs(): { out: string; year?: number; prefCode?: string } {
  const args = process.argv.slice(2);
  let out = "scripts/perf/fixtures.json";
  let year: number | undefined;
  let prefCode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") out = args[++i];
    else if (a === "--year") year = Number(args[++i]);
    else if (a === "--pref") prefCode = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: tsx fetch-fixtures.ts [--out path] [--year YYYY] [--pref code]");
      process.exit(0);
    }
  }
  return { out, year, prefCode };
}

async function main() {
  const { out, year, prefCode } = parseArgs();

  console.error(`Fetching catalog: ${CATALOG_URL}`);
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const body = (await res.json()) as { citygml?: CityGmlEntry[] };
  let entries = body.citygml ?? [];
  console.error(`citygml entries: ${entries.length}`);

  if (year) entries = entries.filter((e) => e.year === year);
  if (prefCode) entries = entries.filter((e) => e.pref_code === prefCode);
  console.error(`after filter: ${entries.length}`);

  // For each citygml entry there is typically only one .url, but a few may carry
  // multiple data sets per year. Take the .url as-is; dedupe by URL.
  const uniq = new Map<string, CityGmlEntry>();
  for (const e of entries) if (e.url && !uniq.has(e.url)) uniq.set(e.url, e);
  const list = [...uniq.values()];
  console.error(`unique zip urls: ${list.length}`);

  console.error(`HEAD probing (concurrency ${HEAD_CONCURRENCY})...`);
  let done = 0;
  const sized = await pool(list, HEAD_CONCURRENCY, async (e) => {
    const size = await headSize(e.url);
    done++;
    if (done % 25 === 0) console.error(`  ${done}/${list.length}`);
    return size == null ? null : { entry: e, size };
  });

  const fixtures: Fixture[] = sized
    .filter((x): x is { entry: CityGmlEntry; size: number } => x !== null)
    .map(({ entry, size }) => ({
      id: entry.id,
      city: entry.city,
      pref: entry.pref,
      year: entry.year,
      url: entry.url,
      size,
      bucket: bucketFor(size),
    }))
    .sort((a, b) => a.size - b.size);

  const failed = sized.filter((x) => x === null).length;
  if (failed) console.error(`WARN: ${failed} entries had no Content-Length`);

  // Summary
  const byBucket = new Map<Bucket, number>();
  for (const f of fixtures) byBucket.set(f.bucket, (byBucket.get(f.bucket) ?? 0) + 1);
  console.error("--- size distribution ---");
  for (const b of BUCKETS) {
    const n = byBucket.get(b.name) ?? 0;
    if (n) console.error(`  ${b.name.padEnd(4)} (<= ${formatBytes(b.max)}): ${n}`);
  }
  console.error(`min: ${formatBytes(fixtures[0]?.size ?? 0)}`);
  console.error(`max: ${formatBytes(fixtures.at(-1)?.size ?? 0)}`);

  const outPath = resolve(out);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2));
  console.error(`wrote ${fixtures.length} fixtures → ${outPath}`);
}

await main();
