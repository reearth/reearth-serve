import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { fixture } from "../../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../../adapters/memory/site-fixture";
import type { Deps } from "../../types";
import { issueCredential, type KeyFile } from "../credential";
import type { BucketName, CredentialId, ObjectKey } from "../model";
import type { ServiceRole } from "../../auth/types";
import { contentRangeOf, declaredHashesOf } from "./app";
import { canonicalRequest, objectPathOf, parseSignedUrl } from "./signed-url";

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

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function postToken(f: Fixture, form: Record<string, string>) {
  return onApi(f, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

async function issuedAhead(keyFile: KeyFile, aud: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id })
    .setIssuer(keyFile.client_email).setAudience(aud)
    .setIssuedAt(iat).setExpirationTime(iat + 3600)
    .sign(await importPKCS8(keyFile.private_key, "RS256"));
}

describe("POST /token", () => {
  test("a missing grant_type is invalid_request", async () => {
    const f = await compatFixture();
    const res = await postToken(f, { assertion: await assertion(await keyFor(f)) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("an assertion issued ten years ahead buys no token, and is no bearer either", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const res = await postToken(f, { grant_type: JWT_BEARER, assertion: await issuedAhead(keyFile, keyFile.token_uri) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect((await onApi(f, "/storage/v1/b/media/o/k", { headers: bearer(await issuedAhead(keyFile, API)) })).status).toBe(401);
  });

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

  test("a bucket outside the grant, in another project or the same one, answers exactly like an unknown bucket", async () => {
    const f = await compatFixture();
    await f.deps.projects.save({ id: "p2", name: "P2", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws2" });
    await f.compat.insertBucket({ name: "tenant-b" as BucketName, projectId: "p2", mount: null, createdAt: 0 });
    const token = await accessToken(f, await keyFor(f));
    const answer = async (bucket: string) => {
      const res = await onApi(f, `/storage/v1/b/${bucket}/o/k`, { headers: bearer(token) });
      return { status: res.status, body: await res.json() };
    };
    const unknown = await answer("nope-bucket");
    expect(unknown).toMatchObject({ status: 404, body: { error: { message: "The specified bucket does not exist.", errors: [{ reason: "notFound" }] } } });
    expect(await answer("tenant-b")).toEqual(unknown);
    expect(await answer("other")).toEqual(unknown);
  });

  test("a bucket the grant reaches but the authorizer refuses is 403", async () => {
    const f = await compatFixture({ serviceAuthorizer: { check: async () => false } });
    const token = await accessToken(f, await keyFor(f));
    const res = await onApi(f, "/storage/v1/b/media/o/k", { headers: bearer(token) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 403, errors: [{ reason: "forbidden" }] } });
  });
});

function multipart(metadata: Record<string, unknown>, media: string, boundary = "b88f") {
  return {
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\n\r\n`
      + `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${media}\r\n--${boundary}--\r\n`,
  };
}

const GO_LIST_PARAMS = "alt=json&delimiter=&endOffset=&includeFoldersAsPrefixes=false&includeTrailingDelimiter=false"
  + "&matchGlob=&pageToken=&prettyPrint=false&projection=full&startOffset=&versions=false";

describe("objects", () => {
  async function editor() {
    const f = await compatFixture();
    await f.deps.projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
    return { f, headers: bearer(await accessToken(f, await keyFor(f, "editor"))) };
  }

  test("a multipart write is described, listed and deleted the way the Go client reads it", async () => {
    const { f, headers } = await editor();
    const upload = multipart({ name: "assets/ab/a.txt", contentType: "text/plain", metadata: { k: "v" }, crc32c: "Yk9x6g==" }, "small body");
    const written = await onApi(f, "/upload/storage/v1/b/media/o?alt=json&name=assets%2Fab%2Fa.txt&prettyPrint=false&projection=full&uploadType=multipart", {
      method: "POST", headers: { ...headers, ...upload.headers }, body: upload.body,
    });
    expect(written.status).toBe(200);
    const resource = await written.json();
    expect(resource).toMatchObject({
      kind: "storage#object", name: "assets/ab/a.txt", bucket: "media", metageneration: "1",
      contentType: "text/plain", size: "10", crc32c: "Yk9x6g==", md5Hash: "KJ2vAHjAOf4oawDFYf2glw==", metadata: { k: "v" },
    });
    expect((resource as { generation: string }).generation).toBe("1");

    const got = await onApi(f, "/storage/v1/b/media/o/assets%2Fab%2Fa.txt?alt=json&prettyPrint=false&projection=full", { headers });
    expect(await got.json()).toEqual(resource);

    const listed = await onApi(f, `/storage/v1/b/media/o?${GO_LIST_PARAMS}`.replace("delimiter=&", "delimiter=%2F&"), { headers });
    expect(await listed.json()).toEqual({ kind: "storage#objects", prefixes: ["assets/"], items: [] });
    const inFolder = await onApi(f, `/storage/v1/b/media/o?${GO_LIST_PARAMS}&prefix=assets%2Fab%2F`, { headers });
    expect(await inFolder.json()).toEqual({ kind: "storage#objects", items: [resource] });

    for (const name of ["assets%2Fab%2Fa.txt", "assets%2Fab%2Fa.txt", "never-written"]) {
      expect((await onApi(f, `/storage/v1/b/media/o/${name}`, { method: "DELETE", headers })).status).toBe(204);
    }
    expect((await onApi(f, "/storage/v1/b/media/o/assets%2Fab%2Fa.txt", { headers })).status).toBe(404);
  });

  test("a declared hash that does not match the bytes is refused and nothing is written", async () => {
    const { f, headers } = await editor();
    const upload = multipart({ name: "k", crc32c: "AAAAAA==" }, "small body");
    const res = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=multipart", { method: "POST", headers: { ...headers, ...upload.headers }, body: upload.body });
    expect(res.status).toBe(400);
    expect(f.compat.bindings.size).toBe(0);
  });

  test("uploadType=media needs a Content-Length", async () => {
    const { f, headers } = await editor();
    const stream = new Blob(["abc"]).stream();
    const res = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=media&name=k", {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
    const sized = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=media&name=k", {
      method: "POST", headers: { ...headers, "Content-Type": "text/plain", "Content-Length": "3" }, body: "abc",
    });
    expect(await sized.json()).toMatchObject({ name: "k", size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" });
  });

  test.each([["10"], ["2"], ["0"]])("a media upload whose Content-Length is %s for a 3-byte body is 400 and stores nothing", async (length) => {
    const { f, headers } = await editor();
    const res = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=media&name=k", {
      method: "POST", headers: { ...headers, "Content-Type": "text/plain", "Content-Length": length }, body: "abc",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 400, errors: [{ reason: "invalid" }] } });
    expect(f.compat.bindings.size).toBe(0);
    expect([...f.metadata.assets.values()].filter((a) => a.projectId === "p1")).toHaveLength(0);
  });

  test.each([["0x2"], ["1e0"], ["1.0"], ["-1"], ["0"], ["abc"]])("maxResults=%s is 400", async (value) => {
    const { f, headers } = await editor();
    expect((await onApi(f, `/storage/v1/b/media/o?maxResults=${value}`, { headers })).status).toBe(400);
  });

  test.each([
    ["matchGlob=*.txt"],
    ["versions=true"],
    ["delimiter=-"],
  ])("a listing with %s answers 501", async (param) => {
    const { f, headers } = await editor();
    expect((await onApi(f, `/storage/v1/b/media/o?${param}`, { headers })).status).toBe(501);
  });

  test("a viewer's write is 403", async () => {
    const f = await compatFixture();
    const headers = bearer(await accessToken(f, await keyFor(f, "viewer")));
    const upload = multipart({ name: "k" }, "x");
    const res = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=multipart", { method: "POST", headers: { ...headers, ...upload.headers }, body: upload.body });
    expect(res.status).toBe(403);
  });
});

describe("resumable uploads", () => {
  async function editor() {
    const f = await compatFixture();
    return { f, headers: bearer(await accessToken(f, await keyFor(f, "editor"))) };
  }

  async function begin(f: Fixture, headers: Record<string, string>) {
    const res = await onApi(f, "/upload/storage/v1/b/media/o?alt=json&name=big.txt&prettyPrint=false&projection=full&uploadType=resumable", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "X-Upload-Content-Type": "text/plain; charset=utf-8" },
      body: JSON.stringify({ bucket: "media", name: "big.txt", metadata: { k: "v" } }),
    });
    expect(res.status).toBe(200);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe(API);
    return `${location.pathname}${location.search}`;
  }

  test("the Go client's exchange: begin, an incomplete chunk acknowledged without a 308, then the final chunk with its CRC32C", async () => {
    const { f, headers } = await editor();
    const session = await begin(f, headers);
    const chunk = await onApi(f, session, {
      method: "POST", headers: { ...headers, "Content-Range": "bytes 0-5/*", "X-GUploader-No-308": "yes" }, body: "hello ",
    });
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("X-Http-Status-Code-Override")).toBe("308");
    expect(chunk.headers.get("Range")).toBe("bytes=0-5");

    const status = await onApi(f, session, { method: "PUT", headers: { ...headers, "Content-Range": "bytes */*" } });
    expect(status.status).toBe(308);
    expect(status.headers.get("Range")).toBe("bytes=0-5");

    const final = await onApi(f, session, {
      method: "POST",
      headers: { ...headers, "Content-Range": "bytes 6-10/11", "X-GUploader-No-308": "yes", "X-Goog-Hash": "crc32c=yZRlqg==" },
      body: "world",
    });
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({
      name: "big.txt", size: "11", contentType: "text/plain; charset=utf-8", metadata: { k: "v" },
      md5Hash: "XrY7u+Ae7tCTyyK7j1rNww==", crc32c: "yZRlqg==",
    });
  });

  test("a final chunk whose X-Goog-Hash does not match is 400 and stores nothing", async () => {
    const { f, headers } = await editor();
    const session = await begin(f, headers);
    const res = await onApi(f, session, {
      method: "PUT", headers: { ...headers, "Content-Range": "bytes 0-10/11", "X-Goog-Hash": "crc32c=AAAAAA==" }, body: "hello world",
    });
    expect(res.status).toBe(400);
    expect(f.compat.bindings.size).toBe(0);
  });

  test("another credential on the same bucket cannot continue the session", async () => {
    const { f, headers } = await editor();
    const session = await begin(f, headers);
    const other = bearer(await accessToken(f, await keyFor(f, "editor")));
    const res = await onApi(f, session, { method: "PUT", headers: { ...other, "Content-Range": "bytes 0-2/3" }, body: "abc" });
    expect(res.status).toBe(403);
  });

  test("DELETE on the session cancels it with 499, and the session is then unknown", async () => {
    const { f, headers } = await editor();
    const session = await begin(f, headers);
    await onApi(f, session, { method: "PUT", headers: { ...headers, "Content-Range": "bytes 0-5/*" }, body: "hello " });
    const cancel = await onApi(f, session, { method: "DELETE", headers });
    expect(cancel.status).toBe(499);
    const status = await onApi(f, session, { method: "PUT", headers: { ...headers, "Content-Range": "bytes */*" } });
    expect(status.status).toBe(404);
    expect((await f.deps.storage.list("compat-staging/")).keys).toEqual([]);
  });

  test.each([
    ["bytes 0-9/*", { start: 0, size: 10, total: null }],
    ["bytes 10-19/20", { start: 10, size: 10, total: 20 }],
    ["bytes */20", { start: null, size: 0, total: 20 }],
    ["bytes */*", "query"],
    ["bytes 9-0/*", null],
    ["bytes 0-20/20", null],
    ["bytes=0-9/*", null],
    [undefined, null],
  ])("Content-Range %s", (header, want) => {
    expect(contentRangeOf(header)).toEqual(want);
  });

  test.each([
    [undefined, { crc32c: null, md5: null }],
    ["crc32c=yZRlqg==", { crc32c: 0xc99465aa, md5: null }],
    ["crc32c=yZRlqg==,md5=XrY7u+Ae7tCTyyK7j1rNww==", { crc32c: 0xc99465aa, md5: expect.any(Uint8Array) }],
    ["crc32c=AAAA", null],
    ["md5=!!", null],
  ])("X-Goog-Hash %s", (header, want) => {
    expect(declaredHashesOf(header)).toEqual(want);
  });
});

describe("a failing dependency", () => {
  const failure = new Error("store down");

  function throwing(f: Fixture, method: "findCredential" | "findCredentialByEmail") {
    Object.assign(f.compat, { [method]: async () => { throw failure; } });
    return vi.spyOn(console, "error").mockImplementation(() => {});
  }

  test("answers 500 in the GCS JSON or XML error shape the client can parse", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const logged = throwing(f, "findCredential");
    const json = await onApi(f, "/storage/v1/b/media/o/k", { headers: bearer(await assertion(keyFile, API)) });
    expect(json.status).toBe(500);
    expect(await json.json()).toMatchObject({ error: { code: 500, errors: [{ reason: "backendError" }] } });
    const xml = await onApi(f, "/media/k", { headers: bearer(await assertion(keyFile, API)) });
    expect(xml.status).toBe(500);
    expect(await xml.text()).toContain("<Code>InternalError</Code>");
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
  });

  test("answers an RFC 6749 JSON error at /token", async () => {
    const f = await compatFixture();
    const keyFile = await keyFor(f);
    const logged = throwing(f, "findCredentialByEmail");
    const res = await postToken(f, { grant_type: JWT_BEARER, assertion: await assertion(keyFile) });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "server_error", error_description: "The token endpoint failed." });
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
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

  test("a trailing-dot API host is still the API host", async () => {
    const f = await compatFixture();
    for (const host of [`${API_HOST}.`, `${API_HOST}.:443`]) {
      const res = await f.app.request(`${API}/api/v1/health`, { headers: { Host: host } });
      expect(res.status).toBe(401);
    }
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

describe("V4 signed URLs", () => {
  type SignOptions = {
    method?: string; path?: string; contentType?: string; contentEncoding?: string; expires?: number; signedAt?: number;
    headers?: Record<string, string>;
  };

  const timestampOf = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  async function signedUrl(keyFile: KeyFile, opts: SignOptions = {}): Promise<string> {
    const timestamp = timestampOf(opts.signedAt ?? Date.now());
    const signedHeaders = ["content-encoding", "content-type", "host"].filter((h) =>
      h === "host" || (h === "content-type" ? opts.contentType : opts.contentEncoding) !== undefined)
      .concat(Object.keys(opts.headers ?? {})).sort();
    const url = new URL(`${API}${opts.path ?? "/media/assets/ab/signed.txt"}`);
    const scope = `${timestamp.slice(0, 8)}/auto/storage/goog4_request`;
    for (const [k, v] of Object.entries({
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": `${keyFile.client_email}/${scope}`,
      "X-Goog-Date": timestamp,
      "X-Goog-Expires": String(opts.expires ?? 900),
      "X-Goog-SignedHeaders": signedHeaders.join(";"),
      "x-app-workspace": "ws1",
      "x-app-project": "p1",
      "x-app-public": "true",
    })) url.searchParams.set(k, v);
    const headers = new Headers(opts.headers);
    if (opts.contentType) headers.set("Content-Type", opts.contentType);
    if (opts.contentEncoding) headers.set("Content-Encoding", opts.contentEncoding);
    const claim = { ...parseSignedUrl(new URL(`${url}&X-Goog-Signature=00`))!, signedHeaders };
    const canonical = canonicalRequest({ method: opts.method ?? "PUT", url, headers }, claim, { apiHost: API_HOST, objectPath: objectPathOf(url.pathname)! });
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))).toString("hex");
    const key = await crypto.subtle.importKey(
      "pkcs8", Buffer.from(keyFile.private_key.replace(/-----[^-]+-----|\s/g, ""), "base64"),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(
      ["GOOG4-RSA-SHA256", timestamp, scope, digest].join("\n"),
    ));
    url.searchParams.set("X-Goog-Signature", Buffer.from(signature).toString("hex"));
    return url.toString();
  }

  const put = (f: Fixture, url: string, body: string, headers: Record<string, string> = {}) =>
    f.app.request(url, { method: "PUT", headers: { Host: API_HOST, "Content-Length": String(body.length), ...headers }, body });

  async function editor(overrides: Partial<Deps> = {}) {
    const f = await compatFixture(overrides);
    const keyFile = await keyFor(f, "editor");
    return { f, keyFile, headers: bearer(await accessToken(f, keyFile)) };
  }

  const cms = { contentType: "application/geo+json", contentEncoding: "gzip" };
  const cmsHeaders = { "Content-Type": cms.contentType, "Content-Encoding": cms.contentEncoding };

  test("a signed PUT with an application's options (content type, Content-Encoding, extra query parameters) stores the bytes with the signed content type and encoding", async () => {
    const { f, keyFile, headers } = await editor();
    const res = await put(f, await signedUrl(keyFile, cms), "small body", cmsHeaders);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-goog-hash")).toBe("crc32c=Yk9x6g==,md5=KJ2vAHjAOf4oawDFYf2glw==");
    expect(res.headers.get("x-goog-generation")).toBe("1");
    const got = await onApi(f, "/storage/v1/b/media/o/assets%2Fab%2Fsigned.txt", { headers });
    expect(await got.json()).toMatchObject({
      name: "assets/ab/signed.txt", contentType: "application/geo+json", contentEncoding: "gzip", size: "10", md5Hash: "KJ2vAHjAOf4oawDFYf2glw==",
    });
  });

  test("a changed content type is SignatureDoesNotMatch in the XML shape", async () => {
    const { f, keyFile } = await editor();
    const res = await put(f, await signedUrl(keyFile, cms), "x", { ...cmsHeaders, "Content-Type": "text/plain" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
  });

  test("the URL writes only its own key, and only with its own method", async () => {
    const { f, keyFile } = await editor();
    const url = await signedUrl(keyFile, cms);
    expect((await put(f, url.replace("signed.txt", "other.txt"), "x", cmsHeaders)).status).toBe(403);
    const get = await f.app.request(url, { headers: { Host: API_HOST, ...cmsHeaders } });
    expect(get.status).toBe(403);
    expect(await get.text()).toContain("<Code>SignatureDoesNotMatch</Code>");
  });

  test("an expired URL is ExpiredToken 400", async () => {
    const { f, keyFile } = await editor();
    const res = await put(f, await signedUrl(keyFile, { ...cms, expires: 1, signedAt: Date.now() - 5_000 }), "x", cmsHeaders);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("<Code>ExpiredToken</Code>");
  });

  test("a revoked credential's URL is refused", async () => {
    const { f, keyFile } = await editor();
    const url = await signedUrl(keyFile, cms);
    await f.compat.revokeCredential("p1", keyFile.private_key_id as CredentialId, Date.now());
    const res = await put(f, url, "x", cmsHeaders);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("<Code>AccessDenied</Code>");
  });

  test("a viewer's signed PUT is refused by the layer", async () => {
    const f = await compatFixture();
    const res = await put(f, await signedUrl(await keyFor(f, "viewer"), cms), "x", cmsHeaders);
    expect(res.status).toBe(403);
  });

  test("a PUT without Content-Length is 411", async () => {
    const { f, keyFile } = await editor();
    const res = await f.app.request(await signedUrl(keyFile), {
      method: "PUT", headers: { Host: API_HOST }, body: new Blob(["abc"]).stream(), duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
  });

  test("with COMPAT_SIGNED_PATH_PREFIX, a URL rewritten under the prefix still writes the object", async () => {
    const { f, keyFile, headers } = await editor({ compatSignedPathPrefix: "/uploads" });
    const rewritten = new URL(await signedUrl(keyFile, cms));
    rewritten.pathname = `/uploads${rewritten.pathname}`;
    expect((await put(f, rewritten.toString(), "small body", cmsHeaders)).status).toBe(200);
    expect((await onApi(f, "/storage/v1/b/media/o/assets%2Fab%2Fsigned.txt", { headers })).status).toBe(200);
  });

  test("a bearer XML PUT writes the object too", async () => {
    const { f, headers } = await editor();
    const res = await put(f, `${API}/media/assets/ab/bearer.txt`, "abc", { ...headers, "Content-Type": "text/plain" });
    expect(res.status).toBe(200);
  });

  const md5Of = (text: string) => createHash("md5").update(text).digest("base64");
  const object = async (f: Fixture, headers: Record<string, string>, bucket = "media", key = "assets/ab/signed.txt") => {
    const res = await onApi(f, `/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`, { headers });
    return res.status === 200 ? await res.json() as { size: string; md5Hash: string; metadata?: Record<string, string> } : res.status;
  };

  describe("signed write headers are enforced, as GCS does", () => {
    test("a body whose MD5 differs from the signed Content-MD5 is 400 BadDigest, and neither a new object nor an overwrite lands", async () => {
      const { f, keyFile, headers } = await editor();
      const url = await signedUrl(keyFile, { headers: { "content-md5": md5Of("the approved file") } });
      const evil = await put(f, url, "other bytes of another length", { "Content-MD5": md5Of("the approved file") });
      expect(evil.status).toBe(400);
      expect(await evil.text()).toContain("<Code>BadDigest</Code>");
      expect(await object(f, headers)).toBe(404);
      expect((await put(f, url, "the approved file", { "Content-MD5": md5Of("the approved file") })).status).toBe(200);
      expect((await put(f, url, "the approved filE", { "Content-MD5": md5Of("the approved file") })).status).toBe(400);
      expect(await object(f, headers)).toMatchObject({ md5Hash: md5Of("the approved file") });
    });

    test("a Content-MD5 that is not a base64 MD5 is 400 InvalidDigest", async () => {
      const { f, keyFile } = await editor();
      const res = await put(f, await signedUrl(keyFile, { headers: { "content-md5": "abc" } }), "x", { "Content-MD5": "abc" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("<Code>InvalidDigest</Code>");
    });

    test.each([
      ["longer than", 400, "x".repeat(11), "EntityTooLarge"],
      ["shorter than", 400, "x", "EntityTooSmall"],
      ["inside", 200, "x".repeat(5), null],
    ])("a body %s the signed x-goog-content-length-range 2,10 answers %s", async (_, status, body, code) => {
      const { f, keyFile, headers } = await editor();
      const range = { "x-goog-content-length-range": "2,10" };
      const res = await put(f, await signedUrl(keyFile, { headers: range }), body, range);
      expect(res.status).toBe(status);
      if (code) expect(await res.text()).toContain(`<Code>${code}</Code>`);
      expect(await object(f, headers)).toEqual(code ? 404 : expect.objectContaining({ size: String(body.length) }));
    });

    test("a create-only URL (x-goog-if-generation-match: 0) writes once, then answers 412", async () => {
      const { f, keyFile, headers } = await editor();
      const createOnly = { "x-goog-if-generation-match": "0" };
      const url = await signedUrl(keyFile, { headers: createOnly });
      expect((await put(f, url, "first", createOnly)).status).toBe(200);
      const second = await put(f, url, "second", createOnly);
      expect(second.status).toBe(412);
      expect(await second.text()).toContain("<Code>PreconditionFailed</Code>");
      expect(await object(f, headers)).toMatchObject({ md5Hash: md5Of("first") });
    });

    test("signed x-goog-meta-* headers become the object's metadata", async () => {
      const { f, keyFile, headers } = await editor();
      const meta = { "x-goog-meta-owner": "alice", "x-goog-meta-source": "cms upload" };
      expect((await put(f, await signedUrl(keyFile, { headers: meta }), "hi", meta)).status).toBe(200);
      expect(await object(f, headers)).toMatchObject({ metadata: { owner: "alice", source: "cms upload" } });
    });

    test.each(["x-goog-acl", "x-goog-if-generation-not-match", "x-goog-content-sha256"])("a URL that signs %s, which Serve does not apply, is 501 NotImplemented", async (name) => {
      const { f, keyFile, headers } = await editor();
      const signed = { [name]: "1" };
      const res = await put(f, await signedUrl(keyFile, { headers: signed }), "x", signed);
      expect(res.status).toBe(501);
      expect(await res.text()).toContain(`<Code>NotImplemented</Code><Message>Not implemented: signed ${name}.</Message>`);
      expect(await object(f, headers)).toBe(404);
    });
  });

  describe("a bearer XML PUT applies the same headers", () => {
    test.each<[string, number, Record<string, string>, string | null]>([
      ["a Content-MD5 of other bytes", 400, { "Content-MD5": md5Of("other") }, "BadDigest"],
      ["an x-goog-content-length-range it falls outside", 400, { "x-goog-content-length-range": "0,2" }, "EntityTooLarge"],
      ["x-goog-if-generation-match of an absent object's other generation", 412, { "x-goog-if-generation-match": "1" }, "PreconditionFailed"],
      ["x-goog-if-generation-not-match", 501, { "x-goog-if-generation-not-match": "1" }, "NotImplemented"],
      ["a matching Content-MD5 and x-goog-meta-owner", 200, { "Content-MD5": md5Of("abc"), "x-goog-meta-owner": "bob" }, null],
    ])("%s answers %s", async (_, status, extra, code) => {
      const { f, headers } = await editor();
      const res = await put(f, `${API}/media/assets/ab/signed.txt`, "abc", { ...headers, ...extra });
      expect(res.status).toBe(status);
      if (code) expect(await res.text()).toContain(`<Code>${code}</Code>`);
      expect(await object(f, headers)).toEqual(code ? 404 : expect.objectContaining({ metadata: { owner: "bob" } }));
    });
  });

  describe("COMPAT_SIGNED_PATH_PREFIX and a bucket named like its first segment", () => {
    async function uploadsBucket() {
      const f = await compatFixture({ compatSignedPathPrefix: "/uploads" });
      await f.compat.insertBucket({ name: "uploads" as BucketName, projectId: "p1", mount: null, createdAt: 0 });
      const { credential, keyFile } = await issueCredential({
        projectId: "p1", bucket: "uploads" as BucketName, role: "editor", label: null, createdBy: "u1", apiOrigin: API, now: Date.now(),
      });
      await f.compat.insertCredential(credential);
      const media = bearer(await accessToken(f, await keyFor(f, "editor")));
      return { f, keyFile, headers: bearer(await accessToken(f, keyFile)), media };
    }

    test("an unprefixed URL for that bucket writes there, and so does the same URL rewritten under the prefix", async () => {
      const { f, keyFile, headers } = await uploadsBucket();
      const url = new URL(await signedUrl(keyFile, { path: "/uploads/a/b.txt" }));
      expect((await put(f, url.toString(), "direct")).status).toBe(200);
      expect(await object(f, headers, "uploads", "a/b.txt")).toMatchObject({ md5Hash: md5Of("direct") });
      url.pathname = `/uploads${url.pathname}`;
      expect((await put(f, url.toString(), "prefixed")).status).toBe(200);
      expect(await object(f, headers, "uploads", "a/b.txt")).toMatchObject({ md5Hash: md5Of("prefixed") });
    });

    test("a URL is written only where it was signed for, never at the other reading of its path", async () => {
      const { f, keyFile, headers, media } = await uploadsBucket();
      const url = await signedUrl(keyFile, { path: "/uploads/media/x.txt" });
      expect((await put(f, url, "in uploads")).status).toBe(200);
      expect(await object(f, headers, "uploads", "media/x.txt")).toMatchObject({ md5Hash: md5Of("in uploads") });
      expect(await object(f, media, "media", "x.txt")).toBe(404);
    });
  });

  test("a virtual-hosted-style URL is 501 in the XML shape, naming the path style", async () => {
    const { f, keyFile } = await editor();
    const res = await f.app.request(`https://media.${API_HOST}/assets/ab/signed.txt${new URL(await signedUrl(keyFile, cms)).search}`, {
      method: "PUT", headers: { Host: `media.${API_HOST}`, "Content-Length": "1", ...cmsHeaders }, body: "x",
    });
    expect(res.status).toBe(501);
    expect(await res.text()).toContain(`<Code>NotImplemented</Code><Message>Not implemented: virtual-hosted-style URLs. Use path-style URLs on ${API_HOST}.</Message>`);
  });

  describe("browser CORS", () => {
    const ORIGIN = "https://cms.example.test";

    test("a preflight from a configured origin is allowed, and the PUT's response is readable", async () => {
      const { f, keyFile } = await editor({ credentialedOrigins: [ORIGIN] });
      const url = await signedUrl(keyFile, cms);
      const preflight = await f.app.request(url, {
        method: "OPTIONS",
        headers: { Host: API_HOST, Origin: ORIGIN, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,content-encoding" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("content-type,content-encoding");
      const res = await put(f, url, "abc", { ...cmsHeaders, Origin: ORIGIN });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    });

    test("another origin gets no CORS headers", async () => {
      const { f, keyFile } = await editor({ credentialedOrigins: [ORIGIN] });
      const preflight = await f.app.request(await signedUrl(keyFile, cms), {
        method: "OPTIONS", headers: { Host: API_HOST, Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" },
      });
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});
