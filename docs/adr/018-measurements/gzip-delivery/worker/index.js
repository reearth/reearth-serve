export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/") return new Response("<!doctype html><title>m1w</title>", { headers: { "content-type": "text/html" } });
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
