import { request as httpRequest } from "node:http";
export const BASE = process.env.E2E_ENDPOINT ?? "http://localhost:8787";
export const MOCK_OIDC = process.env.E2E_MOCK_OIDC ?? "http://localhost:18999";

/**
 * Shared secret the server under test was started with. `/api/internal/*` is
 * fail-closed: without a configured secret it answers 503, and without a
 * matching `Authorization: Bearer` it answers 401 (see core/app.ts). Both
 * e2e launch scripts set the secret and export it here.
 */
export const INTERNAL_API_SECRET = process.env.E2E_INTERNAL_API_SECRET ?? "";

/** Headers authorizing a call to `/api/internal/*`. */
export function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${INTERNAL_API_SECRET}`, ...extra };
}

/**
 * `fetch`, retried once when the connection itself fails.
 *
 * A test that shells out to the CLI leaves this process's keep-alive sockets
 * idle for seconds while a child talks to the same server. The next `fetch`
 * then races the server closing one of them and throws `ECONNRESET` before a
 * byte is on the wire — the request never reached the application. `Connection:
 * close` does not avoid it (undici pools regardless), so the retry is the fix.
 *
 * Only a *thrown* error is retried. Any response, including a `4xx` or `5xx`,
 * comes straight back, so a real failure still fails.
 */
export async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

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
  sessionId?: string,
): Promise<{ status: number; body: any; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(content.byteLength),
    "X-Filename": filename,
  };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  const res = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers,
    body: content as BodyInit,
  });
  return {
    status: res.status,
    body: await res.json(),
    sessionId: res.headers.get("X-Session-Id"),
  };
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
 * `projectId` is required for authenticated uploads (see ADR-002 revision).
 */
export async function uploadFileWithAuth(
  content: Uint8Array,
  filename: string,
  contentType: string,
  token: string,
  projectId?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(content.byteLength),
    "X-Filename": filename,
    "Authorization": `Bearer ${token}`,
  };
  if (projectId) headers["X-Project-Id"] = projectId;
  const res = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers,
    body: content as BodyInit,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Create a project via the API, returning its ID. Used by e2e tests that
 * need a project-scoped authenticated upload.
 */
export async function createProjectForAuth(token: string, name = "e2e-project"): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Project create failed: ${res.status}`);
  const { project } = await res.json() as { project: { id: string } };
  return project.id;
}

/** A GET whose body is the bytes on the wire: fetch would decode a gzip body. */
export function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: new Uint8Array(Buffer.concat(parts)) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Build a minimal valid ZIP file with the given entries.
 * Uses a simple implementation of the ZIP format (no compression — store only).
 */
export function buildMiniZip(files: Record<string, string>): Uint8Array {
  const entries = Object.entries(files);
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const contentBytes = new TextEncoder().encode(content);
    const crc = crc32(contentBytes);

    // Local file header
    const local = new ArrayBuffer(30 + nameBytes.length + contentBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true); // crc32
    lv.setUint32(18, contentBytes.length, true); // compressed size
    lv.setUint32(22, contentBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true); // extra length
    new Uint8Array(local).set(nameBytes, 30);
    new Uint8Array(local).set(contentBytes, 30 + nameBytes.length);
    localHeaders.push(new Uint8Array(local));

    // Central directory header
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true); // crc32
    cv.setUint32(20, contentBytes.length, true); // compressed
    cv.setUint32(24, contentBytes.length, true); // uncompressed
    cv.setUint16(28, nameBytes.length, true); // name length
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    new Uint8Array(central).set(nameBytes, 46);
    centralHeaders.push(new Uint8Array(central));

    offset += 30 + nameBytes.length + contentBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) centralSize += ch.length;

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true); // entries on disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true); // central dir size
  ev.setUint32(16, centralOffset, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const lh of localHeaders) { result.set(lh, pos); pos += lh.length; }
  for (const ch of centralHeaders) { result.set(ch, pos); pos += ch.length; }
  result.set(new Uint8Array(eocd), pos);

  return result;
}

/** Simple CRC-32 implementation for ZIP. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
