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

async function assemble(env, from, to) {
  const index = await (await fetch(env.ORIGIN + "/segindex")).json();
  const segs = index.slice(from, to);
  const start = segs[0].off;
  const end = segs.at(-1).off + segs.at(-1).clen - 1;
  const body = await fetch(env.ORIGIN + "/segments", { headers: { range: `bytes=${start}-${end}` } });
  let crc = 0, len = 0;
  for (const s of segs) { crc = crc32Combine(crc, s.crc, s.len); len += s.len; }
  const trailer = new Uint8Array(10);
  trailer.set([0x03, 0x00]);
  new DataView(trailer.buffer).setUint32(2, crc, true);
  new DataView(trailer.buffer).setUint32(6, len >>> 0, true);
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    await w.write(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]));
    for await (const chunk of body.body) await w.write(chunk);
    await w.write(trailer);
    await w.close();
  })();
  return new Response(readable, {
    headers: { "content-type": "application/octet-stream", "content-encoding": "gzip", "cache-control": "no-store" },
    encodeBody: "manual",
  });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/") return new Response("<!doctype html><title>m1w</title>", { headers: { "content-type": "text/html" } });
    if (u.pathname === "/assemble") return assemble(env, Number(u.searchParams.get("from")), Number(u.searchParams.get("to")));
    const decode = u.pathname.startsWith("/decode/");
    const name = decode ? u.pathname.slice(7) : u.pathname;
    const upstream = await fetch(env.ORIGIN + "/raw" + name);
    if (!upstream.ok) return new Response("nf", { status: 404 });
    if (decode) {
      return new Response(upstream.body.pipeThrough(new DecompressionStream("gzip")), { headers: { "content-type": "application/octet-stream" } });
    }
    return new Response(upstream.body, {
      headers: { "content-type": "application/octet-stream", "content-encoding": "gzip", "cache-control": "no-store" },
      encodeBody: "manual",
    });
  },
};
