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
