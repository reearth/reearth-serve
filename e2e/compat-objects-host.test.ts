import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BASE } from "./helpers";
import { api, issuedKeyFile, onHost, selfSignedBearer } from "./compat-helpers";

const run = promisify(execFile);
const COMPAT_HOST = process.env.E2E_COMPAT_GCS_HOST;
const OBJECTS = process.env.E2E_COMPAT_OBJECTS_HOST;
const GO = await run("go", ["version"]).then(() => true, () => false);
const BODY = "hello, public objects host";
const EMPTY_ZIP = String.fromCharCode(0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0));

async function written(key = "assets/ab/cdef/r.txt", body = BODY, contentType = "text/plain") {
  const issued = await issuedKeyFile();
  const auth = { Authorization: await selfSignedBearer(issued.keyFile) };
  const put = await onHost(COMPAT_HOST!, `/${issued.bucket}/${key}`, {
    ...auth, "Content-Type": contentType, "Content-Length": String(body.length),
  }, "PUT", body);
  expect(put.status).toBe(200);
  const listed = await api(issued.admin, "GET", `/assets?projectId=${issued.projectId}`);
  const [asset] = (await listed.json() as { assets: { id: string }[] }).assets;
  return { ...issued, key, assetId: asset.id, filename: key.split("/").pop()! };
}

const virtualHost = (bucket: string) => `${bucket}.${OBJECTS}`;

describe.runIf(COMPAT_HOST && OBJECTS)("public objects host", () => {
  test("a virtual-host read serves the bytes and the ETag /files serves", async () => {
    const { bucket, key, assetId, filename } = await written();
    const files = await fetch(`${BASE}/files/${assetId}/${filename}`);
    const res = await onHost(virtualHost(bucket), `/${key}`, {});
    expect(res.status).toBe(200);
    expect(res.body).toBe(BODY);
    expect(res.body).toBe(await files.text());
    expect(res.headers.etag).toBe(files.headers.get("ETag"));
    expect(Object.keys(res.headers).filter((name) => name.startsWith("x-goog-"))).toEqual([]);
  });

  test("a path-style read serves the same bytes", async () => {
    const { bucket, key } = await written();
    const res = await onHost(OBJECTS!, `/${bucket}/${key}`, {});
    expect(res.status).toBe(200);
    expect(res.body).toBe(BODY);
  });

  test("a Range read answers 206 with the requested bytes", async () => {
    const { bucket, key } = await written();
    const res = await onHost(virtualHost(bucket), `/${key}`, { Range: "bytes=6-11" });
    expect(res.status).toBe(206);
    expect(res.body).toBe(BODY.slice(6, 12));
    expect(res.headers["content-range"]).toBe(`bytes 6-11/${BODY.length}`);
  });

  test("an If-None-Match of the ETag answers 304", async () => {
    const { bucket, key } = await written();
    const first = await onHost(virtualHost(bucket), `/${key}`, {});
    const again = await onHost(virtualHost(bucket), `/${key}`, { "If-None-Match": String(first.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.body).toBe("");
  });

  test("a password site answers the challenge /files answers", async () => {
    const { admin, bucket, key, assetId, filename } = await written("sites/site.zip", EMPTY_ZIP, "application/zip");
    expect((await api(admin, "PATCH", `/assets/${assetId}`, { access: "password", password: "e2e-objects-host" })).status).toBe(200);
    const files = await fetch(`${BASE}/files/${assetId}/${filename}`);
    const res = await onHost(virtualHost(bucket), `/${key}`, {});
    expect(res.status).toBe(401);
    expect(res.status).toBe(files.status);
    expect(res.headers["www-authenticate"]).toBe(files.headers.get("WWW-Authenticate"));
    expect(JSON.parse(res.body)).toEqual(await files.json());
    const basic = await onHost(virtualHost(bucket), `/${key}`, { Authorization: `Basic ${btoa("x:e2e-objects-host")}` });
    expect(basic.status).toBe(200);
    expect(basic.body).toBe(EMPTY_ZIP);
  });

  test("a restricted object needs a delivery token, which reads through the query", async () => {
    const { admin, bucket, key, assetId } = await written();
    expect((await api(admin, "PATCH", `/assets/${assetId}`, { access: "restricted" })).status).toBe(200);
    const refused = await onHost(virtualHost(bucket), `/${key}`, { Authorization: `Bearer ${admin}` });
    expect(refused.status).toBe(401);
    expect(refused.body).not.toContain(BODY);
    const minted = await api(admin, "POST", `/assets/${assetId}/signed-urls`, { expiresIn: 600 });
    expect(minted.status).toBe(200);
    const { token } = await minted.json() as { token: string };
    const read = await onHost(virtualHost(bucket), `/${key}?serve_token=${encodeURIComponent(token)}`, {});
    expect(read.status).toBe(200);
    expect(read.body).toBe(BODY);
  });

  test("PUT on the objects host answers 405 and changes nothing", async () => {
    const { bucket, key } = await written();
    const res = await onHost(virtualHost(bucket), `/${key}`, { "Content-Type": "text/plain", "Content-Length": "3" }, "PUT", "new");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
    expect((await onHost(virtualHost(bucket), `/${key}`, {})).body).toBe(BODY);
  });

  test("an unknown bucket label and an unknown key answer the same 404", async () => {
    const { bucket, key } = await written();
    const unknownBucket = await onHost(virtualHost("no-such-bucket-e2e"), `/${key}`, {});
    const unknownKey = await onHost(virtualHost(bucket), "/assets/none.txt", {});
    expect(unknownBucket.status).toBe(404);
    expect({ status: unknownKey.status, body: unknownKey.body }).toEqual({ status: unknownBucket.status, body: unknownBucket.body });
  });
});

describe.runIf(COMPAT_HOST && OBJECTS && GO)("CMS public URLs on the objects host (e2e/compat-gcs)", () => {
  let dir: string;
  let binary: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "compat-objects-"));
    binary = join(dir, "compat-gcs");
    await run("go", ["-C", "e2e/compat-gcs", "build", "-o", binary, "."]);
  }, 300_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("cms-url: an object the Go client writes reads at publicBase + key, built as CMS getURL builds it", async () => {
    const issued = await issuedKeyFile();
    const keyPath = join(dir, `${issued.keyFile.private_key_id}.json`);
    await writeFile(keyPath, JSON.stringify(issued.keyFile), { mode: 0o600 });
    const bases = [`http://${virtualHost(issued.bucket)}`, `http://${OBJECTS}/${issued.bucket}`];
    const { stdout } = await run(binary, ["cms-url"], {
      env: {
        ...process.env, E2E_ENDPOINT: BASE, E2E_COMPAT_GCS_HOST: COMPAT_HOST, E2E_GCS_KEY_FILE: keyPath,
        E2E_GCS_BUCKET: issued.bucket, E2E_OBJECTS_PUBLIC_BASES: bases.join(","),
      },
    });
    const line = (base: string) => new RegExp(`^cms url ${escape(base)}/assets/[0-9a-f]{2}/\\{uuid\\[2:\\]\\}/tile%20set%201\\.json: bytes match$`);
    expect(stdout.trim().split("\n")).toEqual([
      expect.stringMatching(line(virtualHost(issued.bucket))),
      expect.stringMatching(line(`${OBJECTS}/${issued.bucket}`)),
    ]);
  }, 120_000);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
