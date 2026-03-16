import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import open from "open";
import { loadConfig, saveConfig, loadCredentials, saveCredentials, clearCredentials } from "./config";
import type { Config } from "./config";

/**
 * Resolve OIDC issuer and client ID from flags, env vars, or config file.
 */
function resolveOidc(flags: { issuer?: string; clientId?: string }): { issuer: string; clientId: string } {
  const config = loadConfig();
  const issuer = flags.issuer || process.env.REEARTH_SERVE_OIDC_ISSUER || config.oidcIssuer;
  const clientId = flags.clientId || process.env.REEARTH_SERVE_CLIENT_ID || config.clientId;

  if (!issuer) {
    throw new Error("OIDC issuer not configured. Use --issuer, REEARTH_SERVE_OIDC_ISSUER env var, or run: reearth-serve config set oidcIssuer <url>");
  }
  if (!clientId) {
    throw new Error("Client ID not configured. Use --client-id, REEARTH_SERVE_CLIENT_ID env var, or run: reearth-serve config set clientId <id>");
  }

  return { issuer, clientId };
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Discover OIDC endpoints from the issuer's well-known configuration.
 */
export async function discoverOidc(issuer: string): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const url = new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Failed to fetch OIDC configuration from ${url}: ${res.status}`);
  }
  const config = await res.json() as { authorization_endpoint: string; token_endpoint: string };
  return {
    authorizationEndpoint: config.authorization_endpoint,
    tokenEndpoint: config.token_endpoint,
  };
}

/**
 * Start a temporary local HTTP server to receive the OAuth callback.
 */
function startCallbackServer(port: number): Promise<{ code: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Login failed</h1><p>${error}</p><p>You can close this tab.</p></body></html>`);
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Login successful!</h1><p>You can close this tab.</p></body></html>");
        resolve({ code, close: () => server.close() });
      }
    });

    server.listen(port, "127.0.0.1");
    server.on("error", reject);
  });
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh the access token using the stored refresh token.
 * Returns the new access token, or null if refresh is not possible.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds?.refreshToken) return null;

  const config = loadConfig();
  if (!config.oidcIssuer || !config.clientId) return null;

  try {
    const endpoints = await discoverOidc(config.oidcIssuer);
    const res = await fetch(endpoints.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: config.clientId,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    saveCredentials({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    });

    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Login via OAuth2 Authorization Code Flow with PKCE.
 */
export async function login(flags: { issuer?: string; clientId?: string }): Promise<void> {
  const { issuer, clientId } = resolveOidc(flags);
  const { codeVerifier, codeChallenge } = generatePkce();
  const endpoints = await discoverOidc(issuer);

  const port = 18920;
  const redirectUri = `http://localhost:${port}/callback`;

  const callbackPromise = startCallbackServer(port);

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Opening browser for login...");
  console.log(`If the browser doesn't open, visit:\n  ${authUrl.toString()}`);
  await open(authUrl.toString());

  const { code, close } = await callbackPromise;

  const tokens = await exchangeCode(endpoints.tokenEndpoint, code, clientId, codeVerifier, redirectUri);

  saveCredentials({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
  });

  // Save issuer and clientId to config for future use
  const config = loadConfig();
  config.oidcIssuer = issuer;
  config.clientId = clientId;
  saveConfig(config);

  close();
  console.log("Login successful!");
}

/**
 * Logout — clear stored credentials.
 */
export function logout(): void {
  clearCredentials();
  console.log("Logged out.");
}

/**
 * Show current user info by decoding the JWT payload.
 */
export function whoami(json: boolean): void {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in.");
    process.exitCode = 1;
    return;
  }

  // Decode JWT payload (no verification — just display)
  const parts = creds.accessToken.split(".");
  if (parts.length !== 3) {
    console.log("Invalid token format.");
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;

  const config = loadConfig();

  if (json) {
    console.log(JSON.stringify({ user: payload, defaultProject: config.defaultProject ?? null }, null, 2));
  } else {
    if (payload.name) console.log(`Name:    ${payload.name}`);
    if (payload.email) console.log(`Email:   ${payload.email}`);
    if (payload.sub) console.log(`Subject: ${payload.sub}`);
    if (config.defaultProject) console.log(`Project: ${config.defaultProject}`);
  }
}
