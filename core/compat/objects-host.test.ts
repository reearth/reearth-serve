import { describe, expect, test, vi } from "vitest";
import { protect, SIGNING_SECRET } from "../../adapters/memory/fixture";
import { mintAuthCookie, SITE_COOKIE } from "../access/cookie";
import { parseHeaders, parseRedirects } from "../site/rules";
import { WebCryptoDeliveryTokenCodec } from "../../adapters/webcrypto/delivery-token";
import { parseDeliveryTokenKeys, toUnixSeconds, type AssetPath, type UnixSeconds } from "../access/token";
import type { BucketName, ObjectKey } from "./model";
import type { UnauthorizedLookup } from "./layer";
import { deliverAsset } from "../file/handler";
import { accessToken, bearer, compatFixture, keyFor, onApi, type Fixture } from "../../adapters/memory/compat-fixture";

const OBJECTS = "objects.example.test";
const BODY = "hello, public reader";
const EMPTY_ZIP = String.fromCharCode(0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0));

const CODEC = new WebCryptoDeliveryTokenCodec(parseDeliveryTokenKeys(JSON.stringify({ active: "k1", keys: { k1: btoa("a".repeat(32)) } })));

async function written(keys: Record<string, string[]> = { media: ["assets/ab/r.txt"] }, body = BODY, contentType = "text/plain") {
  const f = await compatFixture({ deliveryTokens: CODEC });
  const ids: Record<string, string> = {};
  for (const [bucket, names] of Object.entries(keys)) {
    const auth = bearer(await accessToken(f, await keyFor(f, "editor", bucket)));
    for (const key of names) {
      const put = await onApi(f, `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT", headers: { ...auth, "Content-Type": contentType, "Content-Length": String(body.length) }, body,
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

async function answer(res: Response) {
  return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
}

async function missingKey(f: Fixture) {
  return answer(await virtual(f, "/assets/ab/none.txt"));
}

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

  test("a key whose last segment holds an escaped slash or a backslash reads, and refuses as a missing key when restricted", async () => {
    const keys = { "assets/a%2Fb.txt": "/assets/a%252Fb.txt", "assets/a\\b.txt": "/assets/a%5Cb.txt" };
    for (const [key, path] of Object.entries(keys)) {
      const { f, ids } = await written({ media: [key] });
      for (const read of [virtual, pathStyle]) {
        const res = await read(f, path);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(BODY);
      }
      await f.metadata.setProtection(ids[`media/${key}`], { access: "restricted" });
      const miss = await missingKey(f);
      for (const read of [virtual, pathStyle]) expect(await answer(await read(f, path))).toEqual(miss);
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

  test("a password object answers anonymously and to a wrong password exactly as a missing key, and Basic sent up front opens it", async () => {
    const { f, ids } = await written();
    await protect(f.metadata, ids["media/assets/ab/r.txt"], "pw");
    const miss = await missingKey(f);
    for (const read of [virtual, pathStyle]) {
      for (const headers of [{}, { Authorization: `Basic ${btoa("x:wrong")}` }, { Accept: "text/html" }] as Record<string, string>[]) {
        expect(await answer(await read(f, "/assets/ab/r.txt", { headers }))).toEqual(miss);
      }
      const basic = await read(f, "/assets/ab/r.txt", { headers: { Authorization: `Basic ${btoa("x:pw")}` } });
      expect(basic.status).toBe(200);
      expect(await basic.text()).toBe(BODY);
      expect(basic.headers.get("Cache-Control")).toMatch(/^private/);
    }
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
    expect((await onObjects(f, `other.${OBJECTS}`, "/b.txt", { headers })).status).toBe(404);
    expect((await onObjects(f, OBJECTS, "/other/b.txt", { headers })).status).toBe(404);
  });

  test("a restricted object refuses every missing or wrong proof exactly as a missing key, and a delivery token reads it", async () => {
    const { f, ids } = await written({ media: ["assets/ab/r.txt", "assets/ab/s.txt"] });
    const id = ids["media/assets/ab/r.txt"];
    await f.metadata.setProtection(id, { access: "restricted" });
    const now = toUnixSeconds(Date.now());
    const sign = (assetId: string, prefix = "") => CODEC.sign({ assetId, versionId: null, prefix: prefix as AssetPath, exp: (now + 600) as UnixSeconds }, now);
    const own = await sign(id);
    const other = await sign(ids["media/assets/ab/s.txt"]);
    const uncovering = await sign(id, "elsewhere/");
    const miss = await missingKey(f);
    for (const read of [virtual, pathStyle]) {
      for (const [query, headers] of [
        ["", {}],
        ["", { Authorization: "Bearer not-a-delivery-token" }],
        [`?serve_token=${encodeURIComponent(other)}`, {}],
        [`?serve_token=${encodeURIComponent(uncovering)}`, {}],
        [`?serve_token=${encodeURIComponent(own)}`, { "X-Serve-Token": other }],
      ] as [string, Record<string, string>][]) {
        expect(await answer(await read(f, `/assets/ab/r.txt${query}`, { headers }))).toEqual(miss);
      }
      for (const [query, headers] of [[`?serve_token=${encodeURIComponent(own)}`, {}], ["", { "X-Serve-Token": own }]] as [string, Record<string, string>][]) {
        const res = await read(f, `/assets/ab/r.txt${query}`, { headers });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(BODY);
      }
    }
  });

  test("active content downloads as an attachment in a sandbox, as on the apex /files", async () => {
    const types: Record<string, string> = {
      "page.html": "text/html", "image.svg": "image/svg+xml", "page.xhtml": "application/xhtml+xml",
      "data.xml": "application/xml", "app.js": "text/javascript",
    };
    for (const [name, type] of Object.entries(types)) {
      const { f, ids } = await written({ media: [`active/${name}`] }, "<b>x</b>", type);
      const apex = await f.app.request(`http://localhost/files/${ids[`media/active/${name}`]}/${name}`);
      expect(apex.headers.get("Content-Disposition")).toMatch(/^attachment/);
      for (const read of [virtual, pathStyle]) {
        const res = await read(f, `/active/${name}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Disposition")).toBe(apex.headers.get("Content-Disposition"));
        expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      }
    }
  });

  test("a wrong Basic password costs one PBKDF2 whether the key is unbound, restricted, rate limited or a password object", async () => {
    const { f, ids } = await written({ media: ["pw.txt", "restricted.txt", "limited.txt"] });
    await protect(f.metadata, ids["media/pw.txt"], "pw");
    await protect(f.metadata, ids["media/limited.txt"], "pw");
    await f.metadata.setProtection(ids["media/restricted.txt"], { access: "restricted" });
    const wrong = { Authorization: `Basic ${btoa("x:wrong")}`, "X-Forwarded-For": "203.0.113.9" };
    for (let i = 0; i < 12; i++) await virtual(f, "/limited.txt", { headers: wrong });
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const derivations = async (path: string, headers: Record<string, string> = wrong) => {
      derive.mockClear();
      expect((await virtual(f, path, { headers })).status).toBe(404);
      return derive.mock.calls.filter(([alg]) => (alg as Pbkdf2Params).name === "PBKDF2").length;
    };
    expect(await derivations("/pw.txt")).toBe(1);
    for (const path of ["/none.txt", "/restricted.txt", "/limited.txt"]) expect(await derivations(path)).toBe(1);
    expect(await derivations("/none.txt", {})).toBe(0);
    derive.mockClear();
    expect((await f.app.request("http://localhost/files/none/x.txt", { headers: wrong })).status).toBe(404);
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  test("a broken password protection fails closed as a missing key, while /files answers 503", async () => {
    const { f, ids } = await written();
    const id = ids["media/assets/ab/r.txt"];
    await protect(f.metadata, id, "pw");
    f.metadata.protection.delete(id);
    expect((await f.app.request(`http://localhost/files/${id}/r.txt`)).status).toBe(503);
    const miss = await missingKey(f);
    for (const read of [virtual, pathStyle]) {
      for (const headers of [{}, { Authorization: `Basic ${btoa("x:pw")}` }] as Record<string, string>[]) {
        expect(await answer(await read(f, "/assets/ab/r.txt", { headers }))).toEqual(miss);
      }
    }
    await protect(f.metadata, id, "pw");
    const down = vi.spyOn(f.metadata, "findProtection").mockRejectedValue(new Error("metadata down"));
    expect(await answer(await virtual(f, "/assets/ab/r.txt"))).toEqual(miss);
    down.mockRestore();
  });

  test("a storage failure stays a 5xx rather than reading as a missing key", async () => {
    const { f } = await written();
    const get = vi.spyOn(f.storage, "get").mockRejectedValue(new Error("storage down"));
    for (const read of [virtual, pathStyle]) expect((await read(f, "/assets/ab/r.txt")).status).toBe(500);
    get.mockRestore();
    expect((await virtual(f, "/assets/ab/r.txt")).status).toBe(200);
  });

  test("an archive serves the object itself, whatever its _redirects, _headers and SPA settings say", async () => {
    const { f, ids } = await written({ media: ["sites/site.zip"] }, EMPTY_ZIP, "application/zip");
    const id = ids["media/sites/site.zip"];
    const asset = f.metadata.assets.get(id)!;
    const h = parseHeaders("/*\n  X-Site-Rule: applied");
    const r = parseRedirects("/site.zip /moved 301!\n/* /index.html 200");
    f.metadata.assets.set(id, { ...asset, type: "archive", spa: true, hosting: { headers: h.rules, redirects: r.rules, warnings: [] } });
    await f.storage.put(`assets/${id}/files/index.html`, new Blob(["<!doctype html>"]).stream(), "text/html", 15);
    const files = await f.app.request(`http://localhost/files/${id}/site.zip`);
    expect(files.status).toBe(301);
    for (const read of [virtual, pathStyle]) {
      const res = await read(f, "/sites/site.zip");
      expect(res.status).toBe(200);
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.get("X-Site-Rule")).toBeNull();
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(await res.text()).toBe(EMPTY_ZIP);
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
      await onObjects(f, `ab.${OBJECTS}`, "/assets/ab/r.txt"),
      await onObjects(f, `goog-x.${OBJECTS}`, "/assets/ab/r.txt"),
      await onObjects(f, `a.b.${OBJECTS}`, "/assets/ab/r.txt"),
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

  test("a written Content-Type with a comma reads as a sandboxed octet-stream download in both URL forms", async () => {
    for (const type of ["text/plain;x=,text/html", "image/png;,text/html", 'application/json;a=",text/html']) {
      const { f } = await written({ media: ["typed/page"] }, "<script>alert(1)</script>", type);
      for (const read of [virtual, pathStyle]) {
        const res = await read(f, "/typed/page");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
        expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
      }
    }
  });

  test("a multipart upload with a CRLF in its contentType stores a normalized type and reads back", async () => {
    const f = await compatFixture();
    const auth = bearer(await accessToken(f, await keyFor(f, "editor")));
    const boundary = "b88f";
    const metadata = { name: "typed/crlf.txt", contentType: "text/plain\r\nSet-Cookie: pwn=1" };
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\n\r\n`
      + `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${BODY}\r\n--${boundary}--\r\n`;
    const written = await onApi(f, "/upload/storage/v1/b/media/o?uploadType=multipart", {
      method: "POST", headers: { ...auth, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    });
    expect(written.status).toBe(200);
    const stored = (await written.json() as { contentType: string }).contentType;
    expect(stored).not.toMatch(/[\r\n]|Set-Cookie/i);
    for (const read of [virtual, pathStyle]) {
      const res = await read(f, "/typed/crlf.txt");
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("Content-Type")).not.toMatch(/[\r\n]|Set-Cookie/i);
      expect(await res.text()).toBe(BODY);
    }
  });

  test("an unauthorized lookup cannot be delivered as an object the layer opened", () => {
    const deliverLookup = (f: Fixture, located: UnauthorizedLookup) =>
      // @ts-expect-error a lookup made without a principal is not an OpenObject
      deliverAsset(f.storage, new Request("http://localhost/"), { object: located, quotedEtag: "" });
    expect(typeof deliverLookup).toBe("function");
  });
});
