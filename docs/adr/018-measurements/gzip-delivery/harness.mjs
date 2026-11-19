import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { chromium, firefox, webkit } from "playwright";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function payload(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`<bldg:Building gml:id="b${i}"><gml:posList>${(i * 1.2345).toFixed(4)} 35.${i % 997} 139.${i % 991}</gml:posList></bldg:Building>`);
  return Buffer.from(lines.join("\n"));
}

function bgzfMember(chunk) {
  const deflated = zlib.deflateRawSync(chunk, { level: 6 });
  const bsize = 18 + deflated.length + 8 - 1;
  const h = Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0, bsize & 0xff, bsize >> 8]);
  const t = Buffer.alloc(8);
  t.writeUInt32LE(zlib.crc32(chunk) >>> 0, 0);
  t.writeUInt32LE(chunk.length >>> 0, 4);
  return Buffer.concat([h, deflated, t]);
}

function plainMember(chunk) {
  return zlib.gzipSync(chunk);
}

const BGZF_EOF = Buffer.from("1f8b08040000000000ff0600424302001b0003000000000000000000", "hex");

function split(buf, size) {
  const out = [];
  for (let o = 0; o < buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
}

const big = payload(200_000);
const cases = {};
function add(name, plain, body, opts = {}) {
  cases[name] = { plain, body, expect: sha(plain), ...opts };
}

add("single-member", big, plainMember(big));
add("bgzf-64k", big, Buffer.concat([...split(big, 65280).map(bgzfMember), BGZF_EOF]));
add("bgzf-64k-no-eof", big, Buffer.concat(split(big, 65280).map(bgzfMember)));
add("plain-members-1m", big, Buffer.concat(split(big, 1 << 20).map(plainMember)));
add("two-members-tiny", Buffer.from("hello world"), Buffer.concat([plainMember(Buffer.from("hello ")), plainMember(Buffer.from("world"))]));
const mid = split(big, 65280);
const sliceChunks = mid.slice(10, 40);
add("bgzf-range-cut", Buffer.concat(sliceChunks), Buffer.concat(sliceChunks.map(bgzfMember)));
add("bgzf-64k-chunked", big, Buffer.concat([...split(big, 65280).map(bgzfMember), BGZF_EOF]), { chunked: true });
add("empty-member-between", Buffer.from("ab"), Buffer.concat([plainMember(Buffer.from("a")), plainMember(Buffer.alloc(0)), plainMember(Buffer.from("b"))]));

function gf2Times(mat, vec) {
  let sum = 0, i = 0;
  while (vec) { if (vec & 1) sum ^= mat[i]; vec >>>= 1; i++; }
  return sum >>> 0;
}
function gf2Square(sq, mat) { for (let n = 0; n < 32; n++) sq[n] = gf2Times(mat, mat[n]); }
function crc32Combine(crc1, crc2, len2) {
  if (len2 <= 0) return crc1 >>> 0;
  const even = new Array(32), odd = new Array(32);
  odd[0] = 0xedb88320;
  let row = 1;
  for (let n = 1; n < 32; n++) { odd[n] = row; row <<= 1; }
  gf2Square(even, odd);
  gf2Square(odd, even);
  do {
    gf2Square(even, odd);
    if (len2 & 1) crc1 = gf2Times(even, crc1);
    len2 = Math.floor(len2 / 2);
    if (!len2) break;
    gf2Square(odd, even);
    if (len2 & 1) crc1 = gf2Times(odd, crc1);
    len2 = Math.floor(len2 / 2);
  } while (len2);
  return (crc1 ^ crc2) >>> 0;
}

function fullFlushIndex(buf, size) {
  const segs = [];
  for (const chunk of split(buf, size)) {
    const raw = zlib.deflateRawSync(chunk, { level: 6, finishFlush: zlib.constants.Z_FULL_FLUSH });
    segs.push({ raw, crc: zlib.crc32(chunk) >>> 0, len: chunk.length });
  }
  return segs;
}

function singleMemberFromSegments(segs) {
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  const finalEmpty = Buffer.from([0x03, 0x00]);
  let crc = 0, len = 0;
  for (const s of segs) { crc = crc32Combine(crc, s.crc, s.len); len += s.len; }
  const t = Buffer.alloc(8);
  t.writeUInt32LE(crc, 0);
  t.writeUInt32LE(len >>> 0, 4);
  return Buffer.concat([header, ...segs.map((s) => s.raw), finalEmpty, t]);
}

const ff = fullFlushIndex(big, 65536);
add("fullflush-whole", big, singleMemberFromSegments(ff));
const ffCut = ff.slice(10, 40);
add("fullflush-range-cut", Buffer.concat(split(big, 65536).slice(10, 40)), singleMemberFromSegments(ffCut));
add("fullflush-one-seg", split(big, 65536)[7], singleMemberFromSegments([ff[7]]));

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/raw/")) {
    const c = cases[decodeURIComponent(req.url.slice(5))];
    if (!c) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(c.body.length) });
    res.end(c.body);
    return;
  }
  const name = decodeURIComponent(req.url.slice(1));
  if (name === "" || name === "index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>m1</title>");
    return;
  }
  const c = cases[name];
  if (!c) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": "application/octet-stream", "content-encoding": "gzip", "cache-control": "no-store" };
  if (!c.chunked) headers["content-length"] = String(c.body.length);
  res.writeHead(200, headers);
  if (c.chunked) {
    let o = 0;
    const step = () => {
      if (o >= c.body.length) return res.end();
      res.write(c.body.subarray(o, o + 7919));
      o += 7919;
      setImmediate(step);
    };
    step();
  } else res.end(c.body);
});

await new Promise((r) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = process.env.WORKER ?? origin;
if (process.env.SERVE_ONLY) { console.log("serving", origin); await new Promise(() => {}); }

async function inBrowser(type) {
  const browser = await type.launch(type === chromium && process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage();
  await page.goto(base + "/");
  const version = browser.version();
  const results = {};
  for (const [name, c] of Object.entries(cases)) {
    results[name] = await page.evaluate(async ([u, expect]) => {
      try {
        const r = await fetch(u);
        const buf = new Uint8Array(await r.arrayBuffer());
        const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
        const hex = [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
        return { ok: hex === expect, bytes: buf.length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, [`${base}/${encodeURIComponent(name)}`, c.expect]);
    results[name].expectBytes = c.plain.length;
  }
  await browser.close();
  return { version, results };
}

async function inNode() {
  const results = {};
  for (const [name, c] of Object.entries(cases)) {
    const r = await fetch(`${base}/${encodeURIComponent(name)}`);
    const buf = Buffer.from(await r.arrayBuffer());
    results[name] = { ok: sha(buf) === c.expect, bytes: buf.length, expectBytes: c.plain.length };
  }
  return { version: process.version, results };
}

const out = { node: await inNode() };
for (const [n, t] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(",").includes(n))) {
  try { out[n] = await inBrowser(t); } catch (e) { out[n] = { error: String(e).split("\n")[0] }; }
}
server.close();

const sizes = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, { plain: c.plain.length, gz: c.body.length }]));
console.log(JSON.stringify({ sizes, out }, null, 1));
