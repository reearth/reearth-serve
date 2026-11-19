import { describe, expect, test } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { fixture } from "../../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../../adapters/memory/site-fixture";
import type { Deps } from "../../types";
import { issueCredential, type KeyFile } from "../credential";
import type { BucketName, CredentialId, ObjectKey } from "../model";
import type { ServiceRole } from "../../auth/types";

const API_HOST = "storage.example.test";
const API = `https://${API_HOST}`;

async function compatFixture(overrides: Partial<Deps> = {}) {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects, compatApiHost: API_HOST, compatObjectsHost: "objects.example.test", ...overrides });
  for (const name of ["media", "other"]) {
    await f.compat.insertBucket({ name: name as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  }
  return f;
}

type Fixture = Awaited<ReturnType<typeof compatFixture>>;

async function keyFor(f: Fixture, role: ServiceRole = "viewer"): Promise<KeyFile> {
  const { credential, keyFile } = await issueCredential({
    projectId: "p1", bucket: "media" as BucketName, role, label: null, createdBy: "u1", apiOrigin: API, now: Date.now(),
  });
  await f.compat.insertCredential(credential);
  return keyFile;
}

async function assertion(keyFile: KeyFile, aud = keyFile.token_uri): Promise<string> {
  return new SignJWT({ scope: "https://www.googleapis.com/auth/devstorage.full_control" })
    .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id, typ: "JWT" })
    .setIssuer(keyFile.client_email)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPKCS8(keyFile.private_key, "RS256"));
}

function onApi(f: Fixture, path: string, init: RequestInit = {}) {
  return f.app.request(`${API}${path}`, { ...init, headers: { Host: API_HOST, ...init.headers } });
}

async function accessToken(f: Fixture, keyFile: KeyFile): Promise<string> {
  const res = await onApi(f, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await assertion(keyFile) }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { access_token: string; token_type: string; expires_in: number };
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
  return body.access_token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /token", () => {
  test("an assertion signed with another key is invalid_grant", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const other = await keyFor(f);
    const res = await onApi(f, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await assertion({ ...keyFile, private_key: other.private_key }),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "Invalid JWT assertion." });
  });
});

describe("objects.get before objects are served", () => {
  test("a missing key answers 404 in the JSON shape the Go client maps to ErrObjectNotExist", async () => {
    const f = await compatFixture();
    const token = await accessToken(f, await keyFor(f));
    const res = await onApi(f, "/storage/v1/b/media/o/assets%2Fab%2Fmissing.txt?alt=json&prettyPrint=false", { headers: bearer(token) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 404, errors: [{ reason: "notFound" }] } });
  });

  test("a self-signed JWT bearer reaches the same 404", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const res = await onApi(f, "/storage/v1/b/media/o/missing", { headers: bearer(await assertion(keyFile, API)) });
    expect(res.status).toBe(404);
  });

  test("a bound key answers 501 until objects are described", async () => {
    const f = await compatFixture();
    const token = await accessToken(f, await keyFor(f));
    const claim = await f.compat.claim("media" as BucketName, "a/b.txt" as ObjectKey, "object", 0, -1);
    if (claim.kind !== "claimed") throw new Error(claim.kind);
    await f.compat.bind("media" as BucketName, "a/b.txt" as ObjectKey, claim.token, "3f9a1c2b4d5e6f70");
    expect((await onApi(f, "/storage/v1/b/media/o/a%2Fb.txt", { headers: bearer(token) })).status).toBe(501);
  });

  test("an unknown bucket is 404 NoSuchBucket, and a bucket outside the grant is 403", async () => {
    const f = await compatFixture();
    const token = await accessToken(f, await keyFor(f));
    const unknown = await onApi(f, "/storage/v1/b/nope-bucket/o/k", { headers: bearer(token) });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { message: "The specified bucket does not exist." } });
    expect((await onApi(f, "/storage/v1/b/other/o/k", { headers: bearer(token) })).status).toBe(403);
  });
});

describe("bearer auth", () => {
  test("no credential is 401 in the JSON or XML shape of the path", async () => {
    const f = await compatFixture();
    const json = await onApi(f, "/storage/v1/b/media/o/k");
    expect(json.status).toBe(401);
    expect(await json.json()).toMatchObject({ error: { code: 401, errors: [{ reason: "authError" }] } });
    const xml = await onApi(f, "/media/k");
    expect(xml.status).toBe(401);
    expect(await xml.text()).toContain("<Code>AuthenticationRequired</Code>");
  });

  test("revoking the credential turns its cached access token away with 401", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const token = await accessToken(f, keyFile);
    await f.compat.revokeCredential("p1", keyFile.private_key_id as CredentialId, Date.now());
    expect((await onApi(f, "/storage/v1/b/media/o/k", { headers: bearer(token) })).status).toBe(401);
  });
});

describe("routes not built yet", () => {
  test("answer 501 in the GCS JSON or XML error shape", async () => {
    const f = await compatFixture();
    const token = await accessToken(f, await keyFor(f, "editor"));
    const compose = await onApi(f, "/storage/v1/b/media/o/k/compose", { method: "POST", headers: bearer(token) });
    expect(compose.status).toBe(501);
    expect(await compose.json()).toMatchObject({ error: { code: 501, errors: [{ reason: "notImplemented" }] } });
    const xml = await onApi(f, "/media/k", { headers: bearer(token) });
    expect(xml.status).toBe(501);
    expect(await xml.text()).toContain("<Code>NotImplemented</Code>");
  });

  test("the objects host answers 501 in XML for now", async () => {
    const f = await compatFixture();
    const res = await f.app.request("https://media.objects.example.test/k", { headers: { Host: "media.objects.example.test" } });
    expect(res.status).toBe(501);
    expect(await res.text()).toContain("<Code>NotImplemented</Code>");
  });
});

describe("hosts", () => {
  test("no apex route is reachable on the API host", async () => {
    const f = await compatFixture();
    expect((await onApi(f, "/api/v1/health")).status).toBe(401);
  });

  test("the API host wins over a site host suffix it falls under", async () => {
    const f = await compatFixture({ compatApiHost: "storage.localhost:8788", siteHostSuffix: ".localhost:8788" });
    const res = await f.app.request("http://storage.localhost:8788/media/k", { headers: { Host: "storage.localhost:8788" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("<Code>AuthenticationRequired</Code>");
  });

  test("the apex answers as before with the layer configured", async () => {
    const f = await compatFixture();
    expect((await f.app.request("/api/v1/health")).status).toBe(200);
  });

  test("with the layer off, the would-be API host falls through to the app", async () => {
    const f = await compatFixture({ compatApiHost: undefined, compatObjectsHost: undefined });
    expect((await onApi(f, "/api/v1/health")).status).toBe(200);
  });
});
