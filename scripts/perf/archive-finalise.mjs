#!/usr/bin/env node
// Upload finalisation cost and cold first-entry reads (ADR-018 P3).
//
//   # in each checkout: anonymous uploads on and the local D1 schema applied
//   echo 'ANONYMOUS_UPLOAD_ENABLED = "true"' > .dev.vars
//   npx wrangler d1 migrations apply reearth-serve --local
//   npm run dev -- --port 5173   # trunk checkout
//   npm run dev -- --port 5174   # head checkout
//   node scripts/perf/archive-finalise.mjs --trunk http://localhost:5173 --head http://localhost:5174 --runs 5
//
// Part 1 goes over HTTP to two local dev servers, trunk and head interleaved:
// upload completion latency, whose head minus trunk difference is the added
// finalisation, and the first entry request after upload. Part 2 runs head's
// code in this process over the memory adapters, because wrangler dev logs no
// R2 operations: it times finaliseArchive alone and counts the storage reads
// and CPU of a cold first-entry read with and without the index. Local only;
// never point it at a deployed endpoint.
import { parseArgs } from "node:util";
import { register } from "tsx/esm/api";

const { values } = parseArgs({
  options: {
    trunk: { type: "string", default: "http://localhost:5173" },
    head: { type: "string", default: "http://localhost:5174" },
    runs: { type: "string", default: "5" },
    sizes: { type: "string", default: "1000,50000,100000" },
    "skip-http": { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
const sizes = values.sizes.split(",").map(Number);
const targets = { trunk: values.trunk.replace(/\/$/, ""), head: values.head.replace(/\/$/, "") };
for (const url of Object.values(targets)) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`refusing a non-local endpoint: ${url}`);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const entryName = (i) => `udx/bldg/53394611_bldg_6697_op/${String(i).padStart(6, "0")}_bldg_6697_appearance.json`;
const entryBody = (i) => `{"building":${i}}`;

// Stored entries with PLATEAU-length paths: 1k entries fit the 1 MiB tail, 50k and 100k need the index.
function buildZip(count) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const name = enc.encode(entryName(i));
    const data = enc.encode(entryBody(i));
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const zip64 = count >= 0xffff;
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  tail.push(eocd);
  return new Uint8Array(Buffer.concat([...locals, cd, ...tail]));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");
const zips = new Map(sizes.map((n) => [n, buildZip(n)]));
const probeIndex = (n) => Math.floor(n * 0.73);

async function httpRun(endpoint, count) {
  const bytes = zips.get(count);
  const started = performance.now();
  const res = await fetch(`${endpoint}/api/v1/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "Content-Length": String(bytes.byteLength), "X-Filename": `perf-${count}.zip` },
    body: bytes,
  });
  const uploadMs = performance.now() - started;
  if (res.status !== 201) throw new Error(`upload ${count} to ${endpoint}: ${res.status} ${await res.text()}`);
  const { asset } = await res.json();
  const i = probeIndex(count);
  const entryStarted = performance.now();
  const entry = await fetch(`${endpoint}/files/${asset.id}/${entryName(i)}`);
  const text = await entry.text();
  const entryMs = performance.now() - entryStarted;
  if (entry.status !== 200 || text !== entryBody(i)) throw new Error(`entry of ${count} from ${endpoint}: ${entry.status}`);
  return { uploadMs, entryMs, container: asset.container?.index ? "index" : asset.container?.skipped ?? "none" };
}

async function inProcess() {
  register();
  const { MemoryFileStorage } = await import("../../adapters/memory/storage.ts");
  const { createArchiveCache, openArchive, toArchivePath } = await import("../../core/archive/index.ts");
  const { finaliseArchive } = await import("../../core/asset/usecase/finalise-archive.ts");

  return async function run(count) {
    const bytes = zips.get(count);
    const memory = new MemoryFileStorage(1 << 30);
    let reads = 0;
    const storage = {
      put: (...a) => memory.put(...a),
      head: (k) => memory.head(k),
      delete: (k) => memory.delete(k),
      list: (p, o) => memory.list(p, o),
      get: (k, r) => { reads++; return memory.get(k, r); },
    };
    const root = "assets/perf";
    const filename = `perf-${count}.zip`;
    await memory.put(`${root}/${filename}`, new Blob([bytes]).stream(), "application/zip", bytes.byteLength);

    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const finalised = await finaliseArchive({ storage, archives: createArchiveCache() }, { root, filename, size: bytes.byteLength, archiveFormat: "zip" });
    const finaliseMs = performance.now() - t0;
    const finaliseCpu = process.cpuUsage(cpu0);

    const source = { key: `${root}/${filename}`, size: bytes.byteLength, filename };
    const cold = async (src) => {
      const before = reads;
      const cpu = process.cpuUsage();
      const opened = await openArchive({ storage, archives: createArchiveCache() }, src);
      if (!opened.ok) throw new Error(opened.reason);
      const i = probeIndex(count);
      const read = await opened.reader.open(toArchivePath(entryName(i)));
      if (!read.ok) throw new Error(read.reason);
      const text = await new Response(read.file.body).text();
      if (text !== entryBody(i)) throw new Error(`cold read of ${count} returned the wrong body`);
      const used = process.cpuUsage(cpu);
      return { reads: reads - before, cpuMs: (used.user + used.system) / 1000 };
    };
    const index = finalised.container && "index" in finalised.container ? finalised.container.index : undefined;
    const withIndex = index ? await cold({ ...source, index }) : null;
    const withoutIndex = await cold(source);
    return {
      container: index ? "index" : finalised.container?.skipped ?? "none",
      finaliseMs,
      finaliseCpuMs: (finaliseCpu.user + finaliseCpu.system) / 1000,
      indexedReads: withIndex?.reads ?? NaN,
      indexedCpuMs: withIndex?.cpuMs ?? NaN,
      cdReads: withoutIndex.reads,
      cdCpuMs: withoutIndex.cpuMs,
    };
  };
}

if (!values["skip-http"]) {
  const rows = [];
  for (let run = 1; run <= runs; run++) {
    for (const count of sizes) {
      for (const target of ["trunk", "head"]) {
        const row = { run, count, target, ...(await httpRun(targets[target], count)) };
        rows.push(row);
        console.error(JSON.stringify(row));
      }
    }
  }
  console.log("\nHTTP, local dev servers (median of %d runs)", runs);
  console.log("entries | trunk upload ms | head upload ms | added ms | trunk 1st entry ms | head 1st entry ms | head container");
  for (const count of sizes) {
    const pick = (target, key) => median(rows.filter((r) => r.count === count && r.target === target).map((r) => r[key]));
    const container = rows.find((r) => r.count === count && r.target === "head").container;
    console.log(
      `${count} | ${fmt(pick("trunk", "uploadMs"))} | ${fmt(pick("head", "uploadMs"))} | ${fmt(pick("head", "uploadMs") - pick("trunk", "uploadMs"))} | ${fmt(pick("trunk", "entryMs"))} | ${fmt(pick("head", "entryMs"))} | ${container}`,
    );
  }
}

const run = await inProcess();
const local = [];
for (let r = 1; r <= runs; r++) {
  for (const count of sizes) {
    const row = { run: r, count, ...(await run(count)) };
    local.push(row);
    console.error(JSON.stringify(row));
  }
}
console.log("\nIn process, head code over memory storage (median of %d runs; cold = fresh archive cache)", runs);
console.log("entries | container | finalise ms | finalise CPU ms | cold reads indexed | cold CPU ms indexed | cold reads CD | cold CPU ms CD");
for (const count of sizes) {
  const rows = local.filter((r) => r.count === count);
  const m = (key) => median(rows.map((r) => r[key]));
  console.log(
    `${count} | ${rows[0].container} | ${fmt(m("finaliseMs"))} | ${fmt(m("finaliseCpuMs"))} | ${fmt(m("indexedReads"))} | ${fmt(m("indexedCpuMs"))} | ${fmt(m("cdReads"))} | ${fmt(m("cdCpuMs"))}`,
  );
}
