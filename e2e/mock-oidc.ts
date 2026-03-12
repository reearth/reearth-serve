/**
 * Standalone mock OIDC server for E2E testing.
 *
 * Serves:
 *   GET  /.well-known/openid-configuration  — OIDC Discovery
 *   GET  /.well-known/jwks.json             — JWKS public keys
 *   POST /test/sign                         — Sign a JWT (test-only endpoint)
 *
 * Usage:
 *   npx tsx e2e/mock-oidc.ts               → starts on port 18999
 *   MOCK_OIDC_PORT=9000 npx tsx e2e/mock-oidc.ts
 */
import { createServer } from "node:http";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

const PORT = parseInt(process.env.MOCK_OIDC_PORT ?? "18999", 10);

async function main() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const pub = await exportJWK(publicKey);
  const jwks = { keys: [{ ...pub, kid: "e2e-key", alg: "RS256", use: "sig" }] };
  const issuer = `http://localhost:${PORT}/`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${PORT}`);

    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      }));
      return;
    }

    if (url.pathname === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jwks));
      return;
    }

    // Test-only: sign a JWT with custom claims
    if (req.method === "POST" && url.pathname === "/test/sign") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      const { sub, email, name, expiresIn, audience } = body as {
        sub?: string;
        email?: string;
        name?: string;
        expiresIn?: string;
        audience?: string;
      };

      const token = await new SignJWT({
        sub: sub ?? "e2e-user",
        email: email ?? "e2e@example.com",
        name: name ?? "E2E User",
      })
        .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
        .setIssuer(issuer)
        .setAudience(audience ?? "e2e-audience")
        .setExpirationTime(expiresIn ?? "1h")
        .setIssuedAt()
        .sign(privateKey);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(PORT, "127.0.0.1", () => {
    // Signal to parent process that server is ready
    console.log(`MOCK_OIDC_READY ${issuer}`);
  });

  process.on("SIGTERM", () => { server.close(); process.exit(0); });
  process.on("SIGINT", () => { server.close(); process.exit(0); });
}

main();
