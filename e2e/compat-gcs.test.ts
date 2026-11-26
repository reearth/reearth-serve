import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SignJWT, importPKCS8 } from "jose";
import { BASE, signToken } from "./helpers";

const run = promisify(execFile);
const COMPAT_HOST = process.env.E2E_COMPAT_GCS_HOST;
const SIGNED_PATH_PREFIX = process.env.E2E_COMPAT_SIGNED_PATH_PREFIX;
const GO = await run("go", ["version"]).then(() => true, () => false);
// Under wrangler dev the Vite dev server decodes gzip in front of the Worker (see e2e/compression.test.ts).
const NODE_RUNTIME = process.env.E2E_NODE_RUNTIME === "true";

if (COMPAT_HOST && !GO) {
  console.warn("compat-gcs: `go` is not on PATH, so the Go client scenarios are skipped. Install Go 1.26 to run them.");
}

type KeyFile = { private_key_id: string; private_key: string; client_email: string; token_uri: string };

async function api(token: string, method: string, path: string, body?: unknown) {
  return fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function issuedKeyFile() {
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

type CompatResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function onCompatHost(path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<CompatResponse> {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: base.hostname, port: base.port, path, method, headers: { Host: COMPAT_HOST!, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function selfSignedBearer(keyFile: KeyFile): Promise<string> {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id })
    .setIssuer(keyFile.client_email)
    .setAudience(new URL(keyFile.token_uri).origin)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPKCS8(keyFile.private_key, "RS256"));
  return `Bearer ${jwt}`;
}

describe.runIf(COMPAT_HOST)("GCS API bearer auth", () => {
  test("a self-signed JWT built from the key file reaches the missing-object 404", async () => {
    const { bucket, keyFile } = await issuedKeyFile();
    const res = await onCompatHost(`/storage/v1/b/${bucket}/o/missing.txt`, { Authorization: await selfSignedBearer(keyFile) });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 404, errors: [{ reason: "notFound" }] } });
  });

  test("a resumable session refuses another credential of the same bucket, and its own finishes it", async () => {
    const { admin, bucket, keyFile, projectId } = await issuedKeyFile();
    const second = await api(admin, "POST", `/projects/${projectId}/compat/credentials`, { bucket, role: "editor" });
    expect(second.status).toBe(201);
    const owner = { Authorization: await selfSignedBearer(keyFile) };
    const other = { Authorization: await selfSignedBearer(await second.json() as KeyFile) };

    const begun = await onCompatHost(`/upload/storage/v1/b/${bucket}/o?uploadType=resumable&name=hijack.txt`, {
      ...owner, "Content-Type": "application/json",
    }, "POST", JSON.stringify({ name: "hijack.txt", contentType: "text/plain" }));
    expect(begun.status).toBe(200);
    const location = new URL(String(begun.headers.location));
    const session = `${location.pathname}${location.search}`;
    const chunk = { "Content-Range": "bytes 0-2/3", "Content-Length": "3" };

    const hijack = await onCompatHost(session, { ...other, ...chunk }, "PUT", "abc");
    expect(hijack.status).toBe(403);
    const finished = await onCompatHost(session, { ...owner, ...chunk }, "PUT", "abc");
    expect(finished.status).toBe(200);
    expect(JSON.parse(finished.body)).toMatchObject({ name: "hijack.txt", size: "3", md5Hash: "kAFQmDzST7DWlj99KOF/cg==" });
  });
});

describe.runIf(COMPAT_HOST)("GCS API object reads", () => {
  const BODY = "hello, compat reader";
  const EMPTY_ZIP = String.fromCharCode(0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0));

  async function written(name = "r.txt", body = BODY, contentType = "text/plain") {
    const issued = await issuedKeyFile();
    const auth = { Authorization: await selfSignedBearer(issued.keyFile) };
    const path = `/${issued.bucket}/read/${name}`;
    const put = await onCompatHost(path, { ...auth, "Content-Type": contentType, "Content-Length": String(body.length) }, "PUT", body);
    expect(put.status).toBe(200);
    const listed = await api(issued.admin, "GET", `/assets?projectId=${issued.projectId}`);
    const [asset] = (await listed.json() as { assets: { id: string }[] }).assets;
    return { ...issued, auth, path, assetId: asset.id, generation: String(put.headers["x-goog-generation"]) };
  }

  async function setAccess(admin: string, assetId: string, body: Record<string, string>) {
    expect((await api(admin, "PATCH", `/assets/${assetId}`, body)).status).toBe(200);
  }

  test("HEAD on the XML path answers the generation and the stored length", async () => {
    const { auth, path, generation } = await written();
    const res = await onCompatHost(path, auth, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      "x-goog-generation": generation,
      "x-goog-metageneration": "1",
      "x-goog-stored-content-length": String(BODY.length),
      "x-goog-stored-content-encoding": "identity",
    });
    expect(res.body).toBe("");
  });

  test("an If-None-Match of the ETag answers 304", async () => {
    const { auth, path } = await written();
    const first = await onCompatHost(path, auth);
    expect(first.status).toBe(200);
    expect(first.body).toBe(BODY);
    const again = await onCompatHost(path, { ...auth, "If-None-Match": String(first.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.headers["x-goog-hash"]).toBeUndefined();
  });

  test("a password site reads through the API while /files without a cookie still challenges", async () => {
    const { admin, auth, path, assetId } = await written("site.zip", EMPTY_ZIP, "application/zip");
    await setAccess(admin, assetId, { access: "password", password: "e2e-compat-read" });
    const read = await onCompatHost(path, auth);
    expect(read.status).toBe(200);
    expect(read.body).toBe(EMPTY_ZIP);
    const challenged = await fetch(`${BASE}/files/${assetId}/site.zip`);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  test("a restricted asset reads through the API while /files without a proof is 401", async () => {
    const { admin, auth, path, assetId } = await written();
    await setAccess(admin, assetId, { access: "restricted" });
    const read = await onCompatHost(path, auth);
    expect(read.status).toBe(200);
    expect(read.body).toBe(BODY);
    expect((await fetch(`${BASE}/files/${assetId}/r.txt`)).status).toBe(401);
  });

  test("a read without a credential is refused on the XML and JSON paths", async () => {
    const { bucket, path } = await written();
    const xml = await onCompatHost(path, {});
    expect(xml.status).toBe(401);
    expect(xml.body).not.toContain(BODY);
    const json = await onCompatHost(`/storage/v1/b/${bucket}/o/read%2Fr.txt?alt=media`, {});
    expect(json.status).toBe(401);
  });
});

describe.runIf(COMPAT_HOST && GO)("Go storage client v1.69 (e2e/compat-gcs)", () => {
  let dir: string;
  let binary: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "compat-gcs-"));
    binary = join(dir, "compat-gcs");
    await run("go", ["-C", "e2e/compat-gcs", "build", "-o", binary, "."]);
  }, 300_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function scenario(name: string, env: Record<string, string>) {
    return run(binary, [name], { env: { ...process.env, E2E_ENDPOINT: BASE, E2E_COMPAT_GCS_HOST: COMPAT_HOST, ...env } });
  }

  async function keyFileOnDisk() {
    const issued = await issuedKeyFile();
    const path = join(dir, `${issued.keyFile.private_key_id}.json`);
    await writeFile(path, JSON.stringify(issued.keyFile), { mode: 0o600 });
    return { ...issued, path };
  }

  test("attrs-missing: the client exchanges its key file for a token and reads ErrObjectNotExist", async () => {
    const { bucket, path } = await keyFileOnDisk();
    const { stdout } = await scenario("attrs-missing", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    expect(stdout).toMatch(/^storage: object doesn't exist: googleapi: Error 404: No such object/);
  }, 60_000);

  test("revoked: the cached access token answers 401 once the credential is revoked", async () => {
    const { admin, bucket, path, revokeUrl } = await keyFileOnDisk();
    const { stdout } = await scenario("revoked", {
      E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket, E2E_GCS_REVOKE_URL: revokeUrl, E2E_GCS_REVOKE_TOKEN: admin,
    });
    const [before, after] = stdout.trim().split("\n");
    expect(before).toMatch(/^storage: object doesn't exist/);
    expect(after).toBe("after revocation: 401");
  }, 60_000);

  async function assetsOf(admin: string, projectId: string) {
    const res = await api(admin, "GET", `/assets?projectId=${projectId}`);
    expect(res.status).toBe(200);
    return (await res.json() as { assets: { filename: string }[] }).assets;
  }

  test("write-attrs-list-delete: hashes, rising generations, a delimited listing, idempotent deletes and a recreate", async () => {
    const { admin, bucket, path, projectId } = await keyFileOnDisk();
    const { stdout } = await scenario("write-attrs-list-delete", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    expect(stdout.trim().split("\n")).toEqual([
      "overwrite: generation increased",
      "listed: [assets/ab/cdef/a.txt] [assets/ab/cdef/sub/]",
      "deleted: assets/ab/cdef/a.txt",
      "deleted: assets/ab/cdef/a.txt",
      "deleted: never/written.txt",
      "recreate: generation increased",
    ]);
    expect((await assetsOf(admin, projectId)).map((a) => a.filename)).toEqual(["b.txt"]);
  }, 120_000);

  test("paging: 1,050 keys come back from the iterator once each", async () => {
    const { bucket, path } = await keyFileOnDisk();
    const { stdout } = await scenario("paging", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    expect(stdout.trim()).toBe("listed: 1050");
  }, 300_000);

  test("resumable-40m: three 16 MiB-sized chunk requests, hashes that match, and a higher generation on overwrite", async () => {
    const { admin, bucket, path, projectId } = await keyFileOnDisk();
    const { stdout, stderr } = await scenario("resumable-40m", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    console.log(`resumable-40m: ${stderr.trim()}`);
    const write = ["chunk acknowledged: 16777216", "chunk acknowledged: 33554432", "chunk acknowledged: 41943040", "committed: 41943040 bytes"];
    expect(stdout.trim().split("\n")).toEqual([...write, ...write, "overwrite: generation increased"]);
    expect((await assetsOf(admin, projectId)).map((a) => a.filename)).toEqual(["40m.bin"]);
  }, 300_000);

  test("resumable-16m: an object of exactly one chunk ends with the empty final request", async () => {
    const { admin, bucket, path, projectId } = await keyFileOnDisk();
    const { stdout } = await scenario("resumable-16m", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    expect(stdout.trim().split("\n")).toEqual(["chunk acknowledged: 16777216", "committed: 16777216 bytes"]);
    expect((await assetsOf(admin, projectId)).map((a) => a.filename)).toEqual(["16m.bin"]);
  }, 300_000);

  test("signed-put: a URL signed with CMS's options takes a PUT, and Attrs reads its MD5 and signed metadata, also when rewritten under the prefix", async () => {
    const { bucket, path } = await keyFileOnDisk();
    const { stdout } = await scenario("signed-put", {
      E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket, E2E_COMPAT_SIGNED_PATH_PREFIX: SIGNED_PATH_PREFIX ?? "",
    });
    const [first, metadata, ...rest] = stdout.trim().split("\n");
    expect(metadata).toBe("signed x-goog-meta-owner: Attrs metadata owner=alice");
    const puts = [first, ...rest];
    expect(puts).toHaveLength(SIGNED_PATH_PREFIX ? 2 : 1);
    for (const line of puts) expect(line).toMatch(/^signed PUT: 200, Attrs MD5 matches [0-9a-f]{32}$/);
  }, 60_000);

  test("signed-refusals: a tampered, expired, other-key, wrong-method or revoked use of a signed URL is refused, and so is a body its signed headers rule out", async () => {
    const { admin, bucket, path, revokeUrl } = await keyFileOnDisk();
    const { stdout } = await scenario("signed-refusals", {
      E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket, E2E_GCS_REVOKE_URL: revokeUrl, E2E_GCS_REVOKE_TOKEN: admin,
    });
    expect(stdout.trim().split("\n")).toEqual([
      "tampered content type: 403 SignatureDoesNotMatch",
      "expired: 400 ExpiredToken",
      "other key: 403 SignatureDoesNotMatch",
      "wrong method: 403 SignatureDoesNotMatch",
      "content-md5 of other bytes: 400 BadDigest",
      "outside x-goog-content-length-range: 400 EntityTooLarge",
      "create-only over an existing object: 412 PreconditionFailed",
      "unsupported signed header: 501 NotImplemented",
      "revoked: 403 AccessDenied",
    ]);
  }, 60_000);

  test("read: a full read with its CRC32C checked, a 5-byte range, gzip passthrough and decompression, and a missing key", async () => {
    const { bucket, path } = await keyFileOnDisk();
    const { stdout } = await scenario("read", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket, E2E_GZIP_PASSTHROUGH: String(NODE_RUNTIME) });
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^read: 262144 bytes, CRC32C [0-9a-f]{8} checked$/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^range: [0-9a-f]{10}$/),
      NODE_RUNTIME
        ? expect.stringMatching(/^gzip passthrough: \d+ stored bytes, Decompressed false$/)
        : "gzip passthrough: not checked behind a decoding proxy",
      "gzip decompressed: 17408 bytes",
      "missing: ErrObjectNotExist",
    ]);
  }, 120_000);

  test("race: two writers on one new key make one asset and both succeed", async () => {
    const { admin, bucket, path, projectId } = await keyFileOnDisk();
    const { stdout } = await scenario("race", { E2E_GCS_KEY_FILE: path, E2E_GCS_BUCKET: bucket });
    expect(stdout.trim()).toBe("generation: the later of two distinct writes");
    expect((await assetsOf(admin, projectId)).map((a) => a.filename)).toEqual(["new.txt"]);
  }, 120_000);
});
