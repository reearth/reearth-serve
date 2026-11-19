// Storage reads and CPU per zip entry request, in place against extracted (ADR-018 P2).
//
//   npx tsx scripts/perf/archive-serve.ts [--requests 20]
//
// wrangler dev logs no R2 operations, so reads are counted in process over the
// memory adapters. CPU is this process's time per request, a proxy for Worker CPU.
import { parseArgs } from "node:util";
import { deflateRawSync, gunzipSync } from "node:zlib";
import { ASSET_ID, fixture, VERSION_ID } from "../../adapters/memory/fixture";
import { writeZip, type SyntheticEntry } from "../../adapters/memory/zip";

const { values } = parseArgs({ options: { requests: { type: "string", default: "20" } } });
const requests = Number(values.requests);

const ZIP = "site.zip";
const ROOT = `assets/${ASSET_ID}/v/${VERSION_ID}`;
const KIB = new Uint8Array(1024).map((_, i) => (i * 13) & 0xff);
const MIB10 = new Uint8Array(10 << 20).map((_, i) => (i * 7 + (i >> 12)) & 0xff);
const TEXT = new TextEncoder().encode("plain text that compresses well ".repeat(32));

const entries: SyntheticEntry[] = Array.from({ length: 9997 }, (_, i) => ({ name: `tiles/${String(i).padStart(5, "0")}.bin`, data: KIB }));
entries.push({ name: "small.bin", data: KIB }, { name: "big.bin", data: MIB10 });
entries.push({ name: "small.txt", data: TEXT, method: 8, compressed: new Uint8Array(deflateRawSync(TEXT)) });
const zip = writeZip(entries);

const cases = [
  { entry: "small.bin", bytes: KIB, headers: {} },
  { entry: "big.bin", bytes: MIB10, headers: {} },
  { entry: "small.txt", bytes: TEXT, headers: { "Accept-Encoding": "gzip" } },
];

type Mode = "head" | "extracted";

async function server(mode: Mode) {
  const f = await fixture();
  const version = f.versions.versions.get(VERSION_ID)!;
  f.versions.versions.set(VERSION_ID, { ...version, size: zip.byteLength, archiveFormat: "zip", status: mode === "head" ? "pending" : "ready" });
  await f.storage.put(`${ROOT}/${ZIP}`, new Blob([zip as BlobPart]).stream(), "application/zip", zip.byteLength);
  if (mode === "extracted") {
    for (const c of cases) await f.storage.put(`${ROOT}/files/${c.entry}`, new Blob([c.bytes as BlobPart]).stream(), "application/octet-stream", c.bytes.byteLength);
  }
  let reads = 0;
  const get = f.storage.get.bind(f.storage);
  f.storage.get = (key, range) => {
    reads++;
    return get(key, range);
  };
  return {
    async request(entry: string, headers: Record<string, string>, expected: Uint8Array) {
      const before = reads;
      const cpu = process.cpuUsage();
      const res = await f.app.request(`/files/${ASSET_ID}/${entry}`, { headers });
      const body = new Uint8Array(await res.arrayBuffer());
      const used = process.cpuUsage(cpu);
      if (res.status !== 200) throw new Error(`${mode} ${entry}: ${res.status}`);
      const plain = res.headers.get("Content-Encoding") === "gzip" ? new Uint8Array(gunzipSync(body)) : body;
      if (Buffer.compare(plain, expected) !== 0) throw new Error(`${mode} ${entry}: body differs from the entry`);
      return { reads: reads - before, cpuMs: (used.user + used.system) / 1000, bytes: body.byteLength };
    },
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows: { mode: Mode; entry: string; temperature: "cold" | "warm"; reads: number; cpuMs: number }[] = [];

for (const c of cases) {
  for (let i = 0; i < requests; i++) {
    for (const mode of ["head", "extracted"] as const) {
      const s = await server(mode);
      const cold = await s.request(c.entry, c.headers, c.bytes);
      const warm = await s.request(c.entry, c.headers, c.bytes);
      rows.push({ mode, entry: c.entry, temperature: "cold", reads: cold.reads, cpuMs: cold.cpuMs });
      rows.push({ mode, entry: c.entry, temperature: "warm", reads: warm.reads, cpuMs: warm.cpuMs });
    }
  }
}

const summary = [];
for (const c of cases) {
  for (const temperature of ["cold", "warm"] as const) {
    const pick = (mode: Mode) => rows.filter((r) => r.mode === mode && r.entry === c.entry && r.temperature === temperature);
    const head = pick("head");
    const extracted = pick("extracted");
    summary.push({
      entry: c.entry,
      temperature,
      headReadsMax: Math.max(...head.map((r) => r.reads)),
      extractedReadsMax: Math.max(...extracted.map((r) => r.reads)),
      headCpuMedianMs: Number(median(head.map((r) => r.cpuMs)).toFixed(2)),
      extractedCpuMedianMs: Number(median(extracted.map((r) => r.cpuMs)).toFixed(2)),
    });
  }
}
for (const row of summary) console.log(JSON.stringify(row));

const failures = summary.flatMap((s) => [
  ...(s.temperature === "warm" && s.headReadsMax > 1 ? [`${s.entry} warm: ${s.headReadsMax} reads > 1`] : []),
  ...(s.temperature === "cold" && s.headReadsMax > 3 ? [`${s.entry} cold: ${s.headReadsMax} reads > 3`] : []),
  ...(s.temperature === "warm" && s.headCpuMedianMs - s.extractedCpuMedianMs > 2 ? [`${s.entry} warm: CPU ${s.headCpuMedianMs} ms exceeds extracted ${s.extractedCpuMedianMs} ms by more than 2 ms`] : []),
]);
console.log(JSON.stringify({ zipBytes: zip.byteLength, entries: entries.length, requests, pass: failures.length === 0, failures }));
process.exitCode = failures.length === 0 ? 0 : 1;
