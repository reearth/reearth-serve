import { request as httpRequest } from "node:http";
import { expect } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { BASE, signToken } from "./helpers";

export type KeyFile = { private_key_id: string; private_key: string; client_email: string; token_uri: string };

export async function api(token: string, method: string, path: string, body?: unknown) {
  return fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function issuedKeyFile() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const admin = await signToken({ sub: `compat-gcs-${suffix}` });
  const ws = await (await api(admin, "POST", "/workspaces", { name: `compat-gcs-${suffix}` })).json() as { workspace: { id: string } };
  const created = await api(admin, "POST", "/projects", { name: "compat-gcs", workspaceId: ws.workspace.id });
  const { project } = await created.json() as { project: { id: string } };
  const bucket = `gcs-${suffix}`;
  expect((await api(admin, "POST", `/projects/${project.id}/compat/buckets`, { name: bucket })).status).toBe(201);
  const issued = await api(admin, "POST", `/projects/${project.id}/compat/credentials`, { bucket, role: "editor" });
  expect(issued.status).toBe(201);
  const keyFile = await issued.json() as KeyFile;
  const revokeUrl = `${BASE}/api/v1/projects/${project.id}/compat/credentials/${keyFile.private_key_id}`;
  return { admin, bucket, keyFile, revokeUrl, projectId: project.id };
}

export type HostResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

export function onHost(host: string, path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<HostResponse> {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: base.hostname, port: base.port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function selfSignedBearer(keyFile: KeyFile): Promise<string> {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id })
    .setIssuer(keyFile.client_email)
    .setAudience(new URL(keyFile.token_uri).origin)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPKCS8(keyFile.private_key, "RS256"));
  return `Bearer ${jwt}`;
}
