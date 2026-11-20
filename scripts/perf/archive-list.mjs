#!/usr/bin/env node
// Time to a complete in-place zip listing (ADR-018 §3), cold and warm.
//
//   node scripts/perf/archive-list.mjs --endpoint http://localhost:5173 --runs 5 a.zip b.zip
//
// Each run uploads every zip as a new anonymous asset, so its first listing
// misses the isolate cache ("cold"); the second listing of the same asset hits
// it ("warm"). Zips are interleaved within a run. Generate many-entry zips with
// `go run ./scripts/fixtures/zip -out scripts/fixtures/zip/large -large`.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { endpoint: { type: "string", default: "http://localhost:5173" }, runs: { type: "string", default: "5" } },
  allowPositionals: true,
});
const endpoint = values.endpoint.replace(/\/$/, "");
const runs = Number(values.runs);
const zips = positionals.map((path) => ({ name: basename(path), bytes: readFileSync(path) }));

async function upload({ name, bytes }) {
  const res = await fetch(`${endpoint}/api/v1/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "Content-Length": String(bytes.byteLength), "X-Filename": name },
    body: bytes,
  });
  if (res.status !== 201) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`);
  const { asset } = await res.json();
  return { id: asset.id, session: res.headers.get("X-Session-Id") };
}

async function timedListing({ id, session }) {
  const started = performance.now();
  const res = await fetch(`${endpoint}/api/v1/assets/${id}/files`, { headers: session ? { "X-Session-Id": session } : {} });
  const text = await res.text();
  return { ms: performance.now() - started, entries: text.split("\n").filter(Boolean).length, status: res.status };
}

const results = [];
for (let run = 1; run <= runs; run++) {
  for (const zip of zips) {
    const asset = await upload(zip);
    const cold = await timedListing(asset);
    const warm = await timedListing(asset);
    const row = { run, zip: zip.name, entries: cold.entries, coldMs: Math.round(cold.ms), warmMs: Math.round(warm.ms), warmEntries: warm.entries };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const zip of zips) {
  const rows = results.filter((r) => r.zip === zip.name);
  console.log(JSON.stringify({
    zip: zip.name,
    runs: rows.length,
    entries: [...new Set(rows.map((r) => r.entries))],
    coldMedianMs: median(rows.map((r) => r.coldMs)),
    coldMaxMs: Math.max(...rows.map((r) => r.coldMs)),
    warmMedianMs: median(rows.map((r) => r.warmMs)),
    warmMaxMs: Math.max(...rows.map((r) => r.warmMs)),
  }));
}
