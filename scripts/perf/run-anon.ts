#!/usr/bin/env tsx
// Run a perf scenario against a running reearth-serve, in anonymous (demo) mode.
//
// Streams PLATEAU citygml.zip from the source URL straight to the presigned
// upload URL (R2 via the Worker) without buffering the whole file. Then polls
// the asset until extraction reaches `ready` or `failed`, recording phase
// timings.
//
// Usage:
//   tsx scripts/perf/run-anon.ts \
//     --endpoint https://serve.reearth.land \
//     --fixtures scripts/perf/fixtures.json \
//     --buckets XS,S,M \
//     --max-size 5GB \
//     --concurrency 1 \
//     --out scripts/perf/results.jsonl
//
// Selection flags:
//   --ids id1,id2          select by fixture id (city code)
//   --buckets XS,S,L       select by bucket
//   --max-size 2GB         skip fixtures larger than this
//   --min-size 100MB       skip fixtures smaller than this
//   --limit N              cap number of fixtures
//   --pref 13              filter by pref_code
//
// Behavior flags:
//   --concurrency N        number of fixtures uploaded in parallel (default 1)
//   --part-concurrency N   parts per upload in flight (default 3)
//   --part-size BYTES      multipart part size (default 100MB)
//   --poll-interval SECS   asset poll interval (default 5)
//   --poll-timeout SECS    give up polling after this (default 7200)
//   --keep                 do not delete the asset after the run
//   --skip-extraction      send X-Skip-Extraction (pure upload bench)
//   --dry-run              print plan and exit
//
// Output:
//   JSON Lines, one record per fixture, appended to --out.
//   Also prints summary to stderr.

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// --- types matching shared/api.ts ---

type Fixture = {
  id: string;
  city: string;
  pref: string;
  year: number;
  url: string;
  size: number;
  bucket: string;
};

type PresignedUploadResult = {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  contentEncoding?: string;
  expiresAt: number;
};

type MultipartUploadResult = {
  uploadId: string;
  parts: { partNumber: number; url: string }[];
  contentEncoding?: string;
  expiresAt: number;
};

type AssetUploadResult = {
  asset: AssetMetadata;
  url: string;
};

type AssetStatus = "pending" | "ready" | "extracting" | "failed";

type AssetMetadata = {
  id: string;
  filename: string;
  size: number;
  status?: AssetStatus;
  type?: "file" | "archive";
  archiveFormat?: string;
  fileCount?: number;
  extractedSize?: number;
  jobId?: string;
};

type Job = {
  id: string;
  assetId: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  totalFiles?: number;
  fileCount?: number;
  extractedSize?: number;
  retryCount?: number;
  error?: string;
};

// --- args ---

type Args = {
  endpoint: string;
  fixtures: string;
  out: string;
  ids?: Set<string>;
  buckets?: Set<string>;
  maxSize?: number;
  minSize?: number;
  limit?: number;
  pref?: string;
  concurrency: number;
  partConcurrency: number;
  partSize: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  keep: boolean;
  skipExtraction: boolean;
  dryRun: boolean;
};

function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(s.trim());
  if (!m) throw new Error(`bad size: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  const mul = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit]!;
  return Math.round(n * mul);
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const has = (flag: string) => a.includes(flag);
  if (has("-h") || has("--help")) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 40).join("\n"));
    process.exit(0);
  }
  const endpoint = get("--endpoint") ?? "https://serve.reearth.land";
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    fixtures: get("--fixtures") ?? "scripts/perf/fixtures.json",
    out: get("--out") ?? "scripts/perf/results.jsonl",
    ids: get("--ids") ? new Set(get("--ids")!.split(",")) : undefined,
    buckets: get("--buckets") ? new Set(get("--buckets")!.split(",")) : undefined,
    maxSize: get("--max-size") ? parseSize(get("--max-size")!) : undefined,
    minSize: get("--min-size") ? parseSize(get("--min-size")!) : undefined,
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    pref: get("--pref"),
    concurrency: Number(get("--concurrency") ?? 1),
    partConcurrency: Number(get("--part-concurrency") ?? 3),
    partSize: get("--part-size") ? parseSize(get("--part-size")!) : 100 * 1024 * 1024,
    pollIntervalMs: Number(get("--poll-interval") ?? 5) * 1000,
    pollTimeoutMs: Number(get("--poll-timeout") ?? 7200) * 1000,
    keep: has("--keep"),
    skipExtraction: has("--skip-extraction"),
    dryRun: has("--dry-run"),
  };
}

// --- helpers ---

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // matches CLI default

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m${r.toFixed(0)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rangeFetch(url: string, start: number, endIncl: number, retries = 2): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${endIncl}` } });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`source range GET ${start}-${endIncl} -> ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const want = endIncl - start + 1;
      if (buf.byteLength !== want) {
        throw new Error(`short read: want ${want} got ${buf.byteLength}`);
      }
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function putPart(url: string, data: Uint8Array, retries = 2): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: data });
      if (!res.ok) throw new Error(`part PUT -> ${res.status}: ${await res.text().catch(() => "")}`);
      const etag = res.headers.get("ETag");
      if (!etag) throw new Error("part PUT: missing ETag");
      return etag;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Bounded pool that schedules tasks 1..n with at most `c` in flight.
async function pool<R>(n: number, c: number, fn: (i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(n);
  let next = 0;
  const workers = Array.from({ length: Math.min(c, n) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- per-fixture run ---

type PerfRecord = {
  fixture: Fixture;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  upload: {
    mode: "single" | "multipart";
    partCount?: number;
    sizeBytes: number;
    initMs: number;
    transferMs: number;
    completeMs: number;
    throughputMBps: number;
  } | null;
  extraction: {
    pollMs: number;
    transitions: { at: string; status: AssetStatus; fileCount?: number }[];
    finalStatus: AssetStatus | "timeout" | "unknown";
    fileCount?: number;
    extractedSize?: number;
    archiveFormat?: string;
  } | null;
  asset?: { id: string; jobId?: string };
  ok: boolean;
  error?: string;
};

// Mint a server-issued anonymous session.
// X-Session-Id must be a 16-char hex string previously issued by the server,
// so we GET /api/v1/health without headers and read the response header.
async function mintSession(endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}/api/v1/health`);
  const id = res.headers.get("x-session-id");
  if (!id) throw new Error(`could not mint session: no X-Session-Id header (status ${res.status})`);
  return id;
}

async function runFixture(args: Args, fx: Fixture, sessionId: string, rec: PerfRecord): Promise<PerfRecord> {

  const commonHeaders: Record<string, string> = { "X-Session-Id": sessionId };
  const filename = `citygml-${fx.id}-${fx.year}.zip`;
  const contentType = "application/zip";

  try {
    const isMultipart = fx.size > MULTIPART_THRESHOLD;
    const partCount = isMultipart ? Math.ceil(fx.size / args.partSize) : undefined;
    if (partCount && partCount > 10000) {
      throw new Error(`too many parts: ${partCount} (raise --part-size)`);
    }

    // 1) init upload session
    const initStart = Date.now();
    const initRes = await fetch(`${args.endpoint}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...commonHeaders },
      body: JSON.stringify({
        filename,
        contentType,
        size: fx.size,
        partCount,
        ...(args.skipExtraction ? { skipExtraction: true } : {}),
      }),
    });
    if (!initRes.ok) throw new Error(`init upload session ${initRes.status}: ${await initRes.text()}`);
    const session = (await initRes.json()) as PresignedUploadResult | MultipartUploadResult;
    const initMs = Date.now() - initStart;

    // 2) transfer
    const transferStart = Date.now();
    let partsResult: { partNumber: number; etag: string }[] = [];
    if ("parts" in session) {
      // multipart: range-GET source -> PUT part, concurrent
      partsResult = await pool(session.parts.length, args.partConcurrency, async (i) => {
        const part = session.parts[i];
        const start = i * args.partSize;
        const end = Math.min(start + args.partSize, fx.size) - 1;
        const buf = await rangeFetch(fx.url, start, end);
        const etag = await putPart(part.url, buf);
        return { partNumber: part.partNumber, etag };
      });
    } else {
      // single PUT
      const buf = await rangeFetch(fx.url, 0, fx.size - 1);
      const putRes = await fetch(session.url, {
        method: "PUT",
        headers: session.headers,
        body: buf,
      });
      if (!putRes.ok) throw new Error(`single PUT ${putRes.status}: ${await putRes.text()}`);
    }
    const transferMs = Date.now() - transferStart;

    // 3) complete
    // For single PUT: no body (omit Content-Type — server only parses JSON
    // when the header is set). For multipart: send parts with ETags.
    const completeStart = Date.now();
    const completeRes = await fetch(`${args.endpoint}/api/v1/assets/uploads/${session.uploadId}/complete`, {
      method: "POST",
      headers:
        "parts" in session
          ? { "Content-Type": "application/json", ...commonHeaders }
          : { ...commonHeaders },
      ...("parts" in session ? { body: JSON.stringify({ parts: partsResult }) } : {}),
    });
    if (!completeRes.ok) throw new Error(`complete ${completeRes.status}: ${await completeRes.text()}`);
    const completed = (await completeRes.json()) as AssetUploadResult;
    const completeMs = Date.now() - completeStart;

    rec.upload = {
      mode: "parts" in session ? "multipart" : "single",
      partCount,
      sizeBytes: fx.size,
      initMs,
      transferMs,
      completeMs,
      throughputMBps: fx.size / 1024 / 1024 / (transferMs / 1000),
    };
    rec.asset = { id: completed.asset.id, jobId: completed.asset.jobId };

    console.error(
      `[${fx.id} ${fx.bucket} ${fmtBytes(fx.size)}] upload ok ` +
        `init=${fmtDur(initMs)} xfer=${fmtDur(transferMs)} ` +
        `(${rec.upload.throughputMBps.toFixed(1)}MB/s, ${rec.upload.mode}${partCount ? `×${partCount}` : ""}) ` +
        `complete=${fmtDur(completeMs)} assetId=${completed.asset.id}`,
    );

    // 4) poll asset until ready/failed (skipped if skipExtraction)
    if (args.skipExtraction) {
      rec.ok = true;
      return rec;
    }

    const pollStart = Date.now();
    const transitions: { at: string; status: AssetStatus; fileCount?: number }[] = [];
    let lastStatus: AssetStatus | undefined;
    let finalStatus: AssetStatus | "timeout" | "unknown" = "unknown";
    let lastAsset: AssetMetadata | undefined;
    let pollCount = 0;

    for (;;) {
      if (Date.now() - pollStart > args.pollTimeoutMs) {
        finalStatus = "timeout";
        break;
      }
      const r = await fetch(`${args.endpoint}/api/v1/assets/${completed.asset.id}`, { headers: commonHeaders });
      pollCount++;
      if (!r.ok) {
        if (pollCount <= 3 || pollCount % 12 === 0) {
          console.error(`  [${fx.id}] poll#${pollCount} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        }
        await sleep(args.pollIntervalMs);
        continue;
      }
      const meta = ((await r.json()) as { asset: AssetMetadata }).asset;
      lastAsset = meta;
      const st = meta.status ?? "pending";
      // Always print the first poll, every Nth poll, plus every transition,
      // so silent stalls are visible.
      const shouldLog = st !== lastStatus || pollCount === 1 || pollCount % 12 === 0;
      if (st !== lastStatus) {
        transitions.push({ at: new Date().toISOString(), status: st, fileCount: meta.fileCount });
      }
      if (shouldLog) {
        console.error(
          `  [${fx.id}] poll#${pollCount} status=${st}` +
            (meta.type ? ` type=${meta.type}` : "") +
            (meta.jobId ? ` job=${meta.jobId}` : "") +
            (meta.fileCount != null ? ` files=${meta.fileCount}` : "") +
            (meta.extractedSize != null ? ` extracted=${fmtBytes(meta.extractedSize)}` : ""),
        );
      }
      lastStatus = st;
      // A non-archive upload finishes without an extraction phase; treat
      // archive-less assets as ready once the upload completes.
      if (st === "ready" || st === "failed") {
        finalStatus = st;
        break;
      }
      if (meta.type && meta.type !== "archive" && st === "pending") {
        finalStatus = "ready";
        break;
      }
      await sleep(args.pollIntervalMs);
    }

    rec.extraction = {
      pollMs: Date.now() - pollStart,
      transitions,
      finalStatus,
      fileCount: lastAsset?.fileCount,
      extractedSize: lastAsset?.extractedSize,
      archiveFormat: lastAsset?.archiveFormat,
    };
    rec.ok = finalStatus === "ready";
    if (finalStatus === "failed") {
      // try to pull job error
      if (lastAsset?.jobId) {
        try {
          const jr = await fetch(`${args.endpoint}/api/v1/jobs/${lastAsset.jobId}`, { headers: commonHeaders });
          if (jr.ok) {
            const job = (await jr.json()) as Job;
            if (job.error) rec.error = `extraction failed: ${job.error}`;
          }
        } catch {}
      }
      rec.error ??= "extraction failed";
    } else if (finalStatus === "timeout") {
      rec.error = `extraction polling timed out after ${args.pollTimeoutMs / 1000}s`;
    }
  } catch (e) {
    rec.error = e instanceof Error ? e.message : String(e);
    console.error(`[${fx.id}] ERROR: ${rec.error}`);
  } finally {
    rec.finishedAt = new Date().toISOString();
    // Cleanup: only delete on terminal success/failure (not timeout), so a
    // long-running extraction that we stopped polling for is left running to
    // completion on the server side.
    const terminal = rec.extraction?.finalStatus === "ready" || rec.extraction?.finalStatus === "failed";
    if (!args.keep && rec.asset?.id && (terminal || rec.upload == null)) {
      try {
        await fetch(`${args.endpoint}/api/v1/assets/${rec.asset.id}`, {
          method: "DELETE",
          headers: { "X-Session-Id": sessionId },
        });
      } catch {}
    } else if (!args.keep && rec.asset?.id) {
      console.error(`  [${fx.id}] kept (final=${rec.extraction?.finalStatus ?? "?"}); cleanup not run`);
    }
  }
  return rec;
}

// --- main ---

// In-flight records, indexed by sessionId. Flushed on signal.
type InFlight = { runId: string; rec: PerfRecord };
const inFlight = new Map<string, InFlight>();
let signalOutPath: string | null = null;

function installSignalHandlers() {
  const handler = (sig: NodeJS.Signals) => {
    if (signalOutPath && inFlight.size) {
      for (const { runId, rec } of inFlight.values()) {
        rec.finishedAt ||= new Date().toISOString();
        rec.error ||= `interrupted by ${sig}`;
        try {
          appendFileSync(signalOutPath, JSON.stringify({ runId, interrupted: true, ...rec }) + "\n");
        } catch {}
      }
      console.error(`flushed ${inFlight.size} in-flight record(s) → ${signalOutPath}`);
    }
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

async function main() {
  const args = parseArgs();
  const fixtures = JSON.parse(readFileSync(resolve(args.fixtures), "utf8")) as Fixture[];

  let selected = fixtures;
  if (args.ids) selected = selected.filter((f) => args.ids!.has(f.id));
  if (args.buckets) selected = selected.filter((f) => args.buckets!.has(f.bucket));
  if (args.maxSize != null) selected = selected.filter((f) => f.size <= args.maxSize!);
  if (args.minSize != null) selected = selected.filter((f) => f.size >= args.minSize!);
  if (args.pref) selected = selected.filter((f) => f.id.startsWith(args.pref!));
  if (args.limit != null) selected = selected.slice(0, args.limit);

  console.error(`endpoint:    ${args.endpoint}`);
  console.error(`fixtures:    ${args.fixtures} (${fixtures.length} total, ${selected.length} selected)`);
  console.error(`concurrency: ${args.concurrency} (parts ${args.partConcurrency} × ${fmtBytes(args.partSize)})`);
  console.error(`out:         ${args.out}`);
  console.error("--- plan ---");
  for (const f of selected) {
    console.error(`  ${f.bucket.padEnd(4)} ${fmtBytes(f.size).padStart(8)}  ${f.id}  ${f.city}/${f.pref} (${f.year})`);
  }
  if (args.dryRun) {
    console.error("(dry run; exiting)");
    return;
  }
  if (!selected.length) {
    console.error("no fixtures selected");
    return;
  }

  const outPath = resolve(args.out);
  const runId = randomUUID();
  console.error(`runId: ${runId}`);
  signalOutPath = outPath;
  installSignalHandlers();

  // shared session id per fixture? Use one per fixture so anonymous-mode
  // quotas/edges don't accumulate; could also share if you want a single
  // session view.
  const startedAtRun = Date.now();
  let idx = 0;
  let okCount = 0;
  let failCount = 0;
  const workers = Array.from({ length: Math.min(args.concurrency, selected.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= selected.length) return;
      const fx = selected[i];
      const sessionId = await mintSession(args.endpoint);
      console.error(`[${fx.id}] sessionId=${sessionId}`);
      // Register an empty record so SIGINT can flush at least the session id.
      const placeholder: PerfRecord = {
        fixture: fx,
        sessionId,
        startedAt: new Date().toISOString(),
        finishedAt: "",
        upload: null,
        extraction: null,
        ok: false,
      };
      inFlight.set(sessionId, { runId, rec: placeholder });
      let rec: PerfRecord;
      try {
        rec = await runFixture(args, fx, sessionId, placeholder);
      } finally {
        inFlight.delete(sessionId);
      }
      appendFileSync(outPath, JSON.stringify({ runId, ...rec }) + "\n");
      if (rec.ok) okCount++; else failCount++;
    }
  });
  await Promise.all(workers);

  console.error("--- summary ---");
  console.error(`ok=${okCount} fail=${failCount} total=${selected.length} elapsed=${fmtDur(Date.now() - startedAtRun)}`);
  console.error(`results appended to ${outPath}`);
}

await main();
