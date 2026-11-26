import { describe, expect, test } from "vitest";
import { protect, SIGNING_SECRET } from "../../adapters/memory/fixture";
import { mintAuthCookie, SITE_COOKIE } from "../access/cookie";
import type { BucketName, ObjectKey } from "./model";
import { accessToken, bearer, compatFixture, keyFor, onApi, type Fixture } from "./gcs/testing";

const OBJECTS = "objects.example.test";
const BODY = "hello, public reader";

async function written(keys: Record<string, string[]> = { media: ["assets/ab/r.txt"] }) {
  const f = await compatFixture();
  const ids: Record<string, string> = {};
  for (const [bucket, names] of Object.entries(keys)) {
    const auth = bearer(await accessToken(f, await keyFor(f, "editor", bucket)));
    for (const key of names) {
      const put = await onApi(f, `/${bucket}/${key}`, {
        method: "PUT", headers: { ...auth, "Content-Type": "text/plain", "Content-Length": String(BODY.length) }, body: BODY,
      });
      expect(put.status).toBe(200);
      const binding = await f.compat.findBinding(bucket as BucketName, key as ObjectKey);
      ids[`${bucket}/${key}`] = binding?.kind === "object" ? binding.assetId : "";
    }
  }
  return { f, ids };
}

function onObjects(f: Fixture, host: string, path: string, init: RequestInit = {}) {
  return f.app.request(`https://${host}${path}`, { ...init, headers: { Host: host, ...init.headers } });
}

const virtual = (f: Fixture, path: string, init?: RequestInit) => onObjects(f, `media.${OBJECTS}`, path, init);
const pathStyle = (f: Fixture, path: string, init?: RequestInit) => onObjects(f, OBJECTS, `/media${path}`, init);

function googHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((name) => name.startsWith("x-goog-"));
}

describe("objects host", () => {
  test("a public object reads anonymously in both URL forms, with the ETag /files sends", async () => {
    const { f, ids } = await written();
    const files = await f.app.request(`http://localhost/files/${ids["media/assets/ab/r.txt"]}/r.txt`);
    for (const read of [virtual, pathStyle]) {
      const res = await read(f, "/assets/ab/r.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(BODY);
      expect(res.headers.get("ETag")).toBe(files.headers.get("ETag"));
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(res.headers.get("Content-Disposition")).toBe('inline; filename="r.txt"');
      expect(googHeaders(res)).toEqual([]);
    }
  });

  test("HEAD, Range and If-None-Match behave as on /files", async () => {
    const { f } = await written();
    const head = await virtual(f, "/assets/ab/r.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(BODY.length));
    expect(await head.text()).toBe("");
    const range = await virtual(f, "/assets/ab/r.txt", { headers: { Range: "bytes=0-4" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe(BODY.slice(0, 5));
    const again = await virtual(f, "/assets/ab/r.txt", { headers: { "If-None-Match": head.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });

  test("a password object answers the challenge /files answers, and Basic opens it", async () => {
    const { f, ids } = await written();
    const id = ids["media/assets/ab/r.txt"];
    await protect(f.metadata, id, "pw");
    const files = await f.app.request(`http://localhost/files/${id}/r.txt`);
    const res = await virtual(f, "/assets/ab/r.txt");
    expect(res.status).toBe(401);
    expect(res.status).toBe(files.status);
    expect(res.headers.get("WWW-Authenticate")).toBe(files.headers.get("WWW-Authenticate"));
    expect(await res.json()).toEqual(await files.json());
    const basic = await virtual(f, "/assets/ab/r.txt", { headers: { Authorization: `Basic ${btoa("x:pw")}` } });
    expect(basic.status).toBe(200);
    expect(await basic.text()).toBe(BODY);
    expect(basic.headers.get("Cache-Control")).toMatch(/^private/);
  });

  test("a password cookie opens only the asset it names, whichever bucket host carries it", async () => {
    const { f, ids } = await written({ media: ["a.txt"], other: ["b.txt"] });
    for (const id of Object.values(ids)) await protect(f.metadata, id, "pw");
    const protection = await f.metadata.findProtection(ids["media/a.txt"]);
    const cookie = await mintAuthCookie(SIGNING_SECRET, {
      assetId: ids["media/a.txt"], passwordVersion: protection!.version, exp: Math.floor(Date.now() / 1000) + 600,
    });
    const headers = { Cookie: `${SITE_COOKIE}=${cookie}` };
    expect((await onObjects(f, `media.${OBJECTS}`, "/a.txt", { headers })).status).toBe(200);
    expect((await onObjects(f, OBJECTS, "/media/a.txt", { headers })).status).toBe(200);
    expect((await onObjects(f, `other.${OBJECTS}`, "/b.txt", { headers })).status).toBe(401);
    expect((await onObjects(f, OBJECTS, "/other/b.txt", { headers })).status).toBe(401);
  });

  test("a restricted object is refused as on a site host, and an OIDC-style bearer is not a proof here", async () => {
    const { f, ids } = await written();
    await f.metadata.setProtection(ids["media/assets/ab/r.txt"], { access: "restricted" });
    for (const headers of [{}, { Authorization: "Bearer not-a-delivery-token" }] as Record<string, string>[]) {
      const res = await virtual(f, "/assets/ab/r.txt", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("ServeToken");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).not.toContain(BODY);
    }
  });

  test("an unknown bucket and an unknown key answer the same 404", async () => {
    const { f } = await written();
    const misses = [
      await virtual(f, "/assets/ab/none.txt"),
      await pathStyle(f, "/assets/ab/none.txt"),
      await onObjects(f, `nobucket.${OBJECTS}`, "/assets/ab/r.txt"),
      await onObjects(f, OBJECTS, "/nobucket/assets/ab/r.txt"),
      await onObjects(f, OBJECTS, "/media"),
      await virtual(f, "/"),
    ];
    const answers = await Promise.all(misses.map(async (res) => ({
      status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers),
    })));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0].status).toBe(404);
    expect(answers[0].headers["cache-control"]).toBe("no-store");
  });

  test("a folder binding is not served before folder mounts exist", async () => {
    const { f, ids } = await written();
    const token = await f.compat.claim("media" as BucketName, "assets/cd/" as ObjectKey, "folder", Date.now(), 0);
    if (token.kind !== "claimed") throw new Error("claim failed");
    await f.compat.bind("media" as BucketName, "assets/cd/" as ObjectKey, token.token, ids["media/assets/ab/r.txt"]);
    expect((await virtual(f, "/assets/cd/")).status).toBe(404);
    expect((await virtual(f, "/assets/cd/r.txt")).status).toBe(404);
  });

  test("every method but GET and HEAD is 405 with Allow, and nothing is written", async () => {
    const { f } = await written();
    for (const method of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await virtual(f, "/assets/ab/r.txt", { method, body: method === "OPTIONS" ? undefined : "x" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect((await virtual(f, "/_serve/auth", { method: "POST", body: "password=pw" })).status).toBe(405);
    expect(await (await virtual(f, "/assets/ab/r.txt")).text()).toBe(BODY);
  });

  test("API, token and file routes are not reachable on the objects host", async () => {
    const { f, ids } = await written();
    for (const path of ["/api/v1/health", "/token", `/files/${ids["media/assets/ab/r.txt"]}/r.txt`, "/storage/v1/b/media/o", "/media/assets/ab/r.txt"]) {
      const res = await virtual(f, path);
      expect(res.status).toBe(404);
    }
    expect((await onObjects(f, OBJECTS, `/files/${ids["media/assets/ab/r.txt"]}/r.txt`)).status).toBe(404);
  });

  test("only a delivery token rides into delivery from the query", async () => {
    const { f } = await written();
    const res = await virtual(f, "/assets/ab/r.txt?thumb=xs");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });
});
