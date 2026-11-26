import { SignJWT, importPKCS8 } from "jose";
import { fixture } from "./fixture";
import { MemoryProjectStore } from "./site-fixture";
import type { Deps } from "../../core/types";
import type { ServiceRole } from "../../core/auth/types";
import { issueCredential, type KeyFile } from "../../core/compat/credential";
import type { BucketName } from "../../core/compat/model";

export const API_HOST = "storage.example.test";
export const API = `https://${API_HOST}`;

export async function compatFixture(overrides: Partial<Deps> = {}) {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects, compatApiHost: API_HOST, compatObjectsHost: "objects.example.test", ...overrides });
  for (const name of ["media", "other"]) {
    await f.compat.insertBucket({ name: name as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  }
  return f;
}

export type Fixture = Awaited<ReturnType<typeof compatFixture>>;

export async function keyFor(f: Fixture, role: ServiceRole = "viewer", bucket = "media"): Promise<KeyFile> {
  const { credential, keyFile } = await issueCredential({
    projectId: "p1", bucket: bucket as BucketName, role, label: null, createdBy: "u1", apiOrigin: API, now: Date.now(),
  });
  await f.compat.insertCredential(credential);
  return keyFile;
}

export async function assertion(keyFile: KeyFile, aud = keyFile.token_uri): Promise<string> {
  return new SignJWT({ scope: "https://www.googleapis.com/auth/devstorage.full_control" })
    .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id, typ: "JWT" })
    .setIssuer(keyFile.client_email)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPKCS8(keyFile.private_key, "RS256"));
}

export function onApi(f: Fixture, path: string, init: RequestInit = {}) {
  return f.app.request(`${API}${path}`, { ...init, headers: { Host: API_HOST, ...init.headers } });
}

export async function accessToken(f: Fixture, keyFile: KeyFile): Promise<string> {
  const res = await onApi(f, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await assertion(keyFile) }),
  });
  const body = await res.json() as { access_token?: string; token_type?: string; expires_in?: number };
  if (res.status !== 200 || body.token_type !== "Bearer" || body.expires_in !== 3600 || !body.access_token) {
    throw new Error(`/token answered ${res.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
