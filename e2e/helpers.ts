export const BASE = process.env.E2E_ENDPOINT ?? "http://localhost:8787";
export const MOCK_OIDC = process.env.E2E_MOCK_OIDC ?? "http://localhost:18999";

export function rewriteUrl(url: string): string {
  const parsed = new URL(url);
  const base = new URL(BASE);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}

export async function uploadFile(
  content: Uint8Array,
  filename: string,
  contentType: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(content.byteLength),
      "X-Filename": filename,
    },
    body: content as BodyInit,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Sign a JWT via the mock OIDC server's test endpoint.
 */
export async function signToken(claims: {
  sub?: string;
  email?: string;
  name?: string;
  expiresIn?: string;
  audience?: string;
} = {}): Promise<string> {
  const res = await fetch(`${MOCK_OIDC}/test/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claims),
  });
  if (!res.ok) throw new Error(`Mock OIDC sign failed: ${res.status}`);
  const { token } = await res.json() as { token: string };
  return token;
}

/**
 * Upload a file with authentication.
 */
export async function uploadFileWithAuth(
  content: Uint8Array,
  filename: string,
  contentType: string,
  token: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(content.byteLength),
      "X-Filename": filename,
      "Authorization": `Bearer ${token}`,
    },
    body: content as BodyInit,
  });
  return { status: res.status, body: await res.json() };
}
