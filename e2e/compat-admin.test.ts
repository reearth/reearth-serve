import { describe, expect, test } from "vitest";
import { BASE, signToken } from "./helpers";

const COMPAT_HOST = process.env.E2E_COMPAT_GCS_HOST;

async function api(token: string, method: string, path: string, body?: unknown) {
  return fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function workspaceProjectWithAdminAndViewer() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await signToken({ sub: `compat-owner-${suffix}` });
  const admin = await signToken({ sub: `compat-admin-${suffix}` });
  const viewer = await signToken({ sub: `compat-viewer-${suffix}` });
  const ws = await (await api(owner, "POST", "/workspaces", { name: `compat-${suffix}` })).json() as { workspace: { id: string } };
  for (const [user, role] of [[`compat-admin-${suffix}`, "admin"], [`compat-viewer-${suffix}`, "viewer"]]) {
    expect((await api(owner, "POST", `/workspaces/${ws.workspace.id}/members`, { userId: user, role })).status).toBe(201);
  }
  const created = await api(owner, "POST", "/projects", { name: "compat", workspaceId: ws.workspace.id });
  expect(created.status).toBe(201);
  const { project } = await created.json() as { project: { id: string } };
  return { id: project.id, admin, viewer, bucket: `media-${suffix}` };
}

describe("compat buckets", () => {
  test("an admin creates a bucket; a taken name is 409 and a bad name 400", async () => {
    const p = await workspaceProjectWithAdminAndViewer();
    const mount = { prefix: "assets/", depth: 2, strip: "skip-top" };
    const res = await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket, mount });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ bucket: { name: p.bucket, projectId: p.id, mount, createdAt: expect.any(Number) } });

    expect((await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket })).status).toBe(409);
    expect((await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: "Not_A_Bucket!" })).status).toBe(400);

    const list = await api(p.viewer, "GET", `/projects/${p.id}/compat/buckets`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { buckets: { name: string }[] }).buckets.map((b) => b.name)).toEqual([p.bucket]);
  });

  test("a viewer cannot create or delete a bucket", async () => {
    const p = await workspaceProjectWithAdminAndViewer();
    expect((await api(p.viewer, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket })).status).toBe(403);
    await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket });
    expect((await api(p.viewer, "DELETE", `/projects/${p.id}/compat/buckets/${p.bucket}`)).status).toBe(403);
  });

  test("an admin deletes an empty bucket, and a second delete is 404", async () => {
    const p = await workspaceProjectWithAdminAndViewer();
    await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket });
    expect((await api(p.admin, "DELETE", `/projects/${p.id}/compat/buckets/${p.bucket}`)).status).toBe(204);
    expect((await api(p.admin, "DELETE", `/projects/${p.id}/compat/buckets/${p.bucket}`)).status).toBe(404);
  });
});

describe.runIf(COMPAT_HOST)("compat credentials", () => {
  async function withBucket() {
    const p = await workspaceProjectWithAdminAndViewer();
    expect((await api(p.admin, "POST", `/projects/${p.id}/compat/buckets`, { name: p.bucket })).status).toBe(201);
    return p;
  }

  test("an admin issues a key file once, and the list never shows the private key", async () => {
    const p = await withBucket();
    const res = await api(p.admin, "POST", `/projects/${p.id}/compat/credentials`, { bucket: p.bucket, role: "editor", label: "cms" });
    expect(res.status).toBe(201);
    const keyFile = await res.json() as Record<string, string>;
    expect(keyFile).toEqual({
      type: "service_account",
      project_id: p.id,
      private_key_id: expect.any(String),
      private_key: expect.stringMatching(/^-----BEGIN PRIVATE KEY-----\n/),
      client_email: `${keyFile.private_key_id}@${new URL(`http://${COMPAT_HOST}`).hostname}`,
      client_id: keyFile.private_key_id,
      token_uri: expect.stringMatching(new RegExp(`^https?://${COMPAT_HOST!.replace(/\./g, "\\.")}/token$`)),
    });

    const list = await api(p.admin, "GET", `/projects/${p.id}/compat/credentials`);
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).not.toContain("PRIVATE KEY");
    expect(JSON.parse(body)).toEqual({
      credentials: [{
        id: keyFile.private_key_id, projectId: p.id, bucket: p.bucket, role: "editor",
        clientEmail: keyFile.client_email, label: "cms", createdBy: expect.any(String),
        createdAt: expect.any(Number), revokedAt: null,
      }],
    });
  });

  test("admin and owner roles are refused with 400, and an unknown bucket is 404", async () => {
    const p = await withBucket();
    for (const role of ["admin", "owner"]) {
      expect((await api(p.admin, "POST", `/projects/${p.id}/compat/credentials`, { bucket: p.bucket, role })).status).toBe(400);
    }
    expect((await api(p.admin, "POST", `/projects/${p.id}/compat/credentials`, { bucket: "no-such-bucket", role: "viewer" })).status).toBe(404);
  });

  test("a viewer can neither issue nor list credentials", async () => {
    const p = await withBucket();
    expect((await api(p.viewer, "POST", `/projects/${p.id}/compat/credentials`, { bucket: p.bucket, role: "viewer" })).status).toBe(403);
    expect((await api(p.viewer, "GET", `/projects/${p.id}/compat/credentials`)).status).toBe(403);
  });

  test("revoking sets revokedAt, and deleting the bucket revokes what is left", async () => {
    const p = await withBucket();
    const issue = async () =>
      (await (await api(p.admin, "POST", `/projects/${p.id}/compat/credentials`, { bucket: p.bucket, role: "viewer" })).json() as { private_key_id: string }).private_key_id;
    const first = await issue();
    const second = await issue();

    expect((await api(p.admin, "DELETE", `/projects/${p.id}/compat/credentials/${first}`)).status).toBe(204);
    expect((await api(p.admin, "DELETE", `/projects/${p.id}/compat/credentials/nope`)).status).toBe(404);
    const revokedAt = async () => {
      const { credentials } = await (await api(p.admin, "GET", `/projects/${p.id}/compat/credentials`)).json() as { credentials: { id: string; revokedAt: number | null }[] };
      return Object.fromEntries(credentials.map((c) => [c.id, c.revokedAt]));
    };
    const afterRevoke = await revokedAt();
    expect(afterRevoke[first]).toEqual(expect.any(Number));
    expect(afterRevoke[second]).toBeNull();

    expect((await api(p.admin, "DELETE", `/projects/${p.id}/compat/buckets/${p.bucket}`)).status).toBe(204);
    const afterDelete = await revokedAt();
    expect(afterDelete[first]).toBe(afterRevoke[first]);
    expect(afterDelete[second]).toEqual(expect.any(Number));
  });
});
