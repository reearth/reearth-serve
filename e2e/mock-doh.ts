/**
 * Standalone mock DNS-over-HTTPS resolver for E2E testing (ADR-013 B5).
 *
 * Custom-domain verification reads a TXT record the customer published. The
 * Node runtime uses the real DoH adapter, so an e2e verify would otherwise ask
 * Cloudflare's public resolver about a domain the test does not own. Pointing
 * `SITE_DNS_RESOLVER_URL` at this instead keeps the whole path — adapter,
 * query string, `application/dns-json` parsing — under test without leaving
 * the machine.
 *
 * Serves:
 *   GET  /dns-query?name=&type=TXT  — the DoH JSON API the adapter speaks
 *   POST /test/txt {name, values}   — publish a record (test-only)
 *
 * Usage:
 *   npx tsx e2e/mock-doh.ts          → starts on port 18997
 *   MOCK_DOH_PORT=9000 npx tsx e2e/mock-doh.ts
 */
import { createServer } from "node:http";

const PORT = parseInt(process.env.MOCK_DOH_PORT ?? "18997", 10);

/** `type` of a TXT record in a DNS answer (RFC 1035). */
const TXT = 16;

const records = new Map<string, string[]>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/dns-query") {
    const name = (url.searchParams.get("name") ?? "").toLowerCase().replace(/\.$/, "");
    const values = url.searchParams.get("type") === "TXT" ? records.get(name) ?? [] : [];
    res.writeHead(200, { "Content-Type": "application/dns-json" });
    res.end(JSON.stringify({
      Status: 0,
      // Quoted character strings, the way a real resolver spells them — so the
      // adapter's unquoting is exercised too.
      Answer: values.map((data) => ({ name, type: TXT, TTL: 60, data: `"${data}"` })),
    }));
    return;
  }

  // Test-only: publish (or replace) the TXT records at a name.
  if (req.method === "POST" && url.pathname === "/test/txt") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { name?: string; values?: string[] };
    if (!body.name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "name is required" }));
      return;
    }
    records.set(body.name.toLowerCase().replace(/\.$/, ""), body.values ?? []);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  // Signal to the parent process that the server is ready.
  console.log(`MOCK_DOH_READY http://localhost:${PORT}/dns-query`);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
