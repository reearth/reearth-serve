import { describe, expect, test } from "vitest";
import { APP_JS, ASSET_ID, fixture, INDEX_HTML, seedEntry } from "../../adapters/memory/fixture";

const SIZE = INDEX_HTML.length;
const read = async (range: string, path = "index.html") => {
  const { app, storage } = await fixture();
  await seedEntry(storage, "empty.txt", "", "text/plain");
  return app.request(`/files/${ASSET_ID}/${path}`, { headers: { Range: range } });
};

describe("Range on /files (RFC 9110 §14)", () => {
  test.each([
    ["bytes=-5", INDEX_HTML.slice(-5), `bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`],
    [`bytes=-${SIZE + 10}`, INDEX_HTML, `bytes 0-${SIZE - 1}/${SIZE}`],
    [`bytes=3-${SIZE + 10}`, INDEX_HTML.slice(3), `bytes 3-${SIZE - 1}/${SIZE}`],
    ["bytes=4-", INDEX_HTML.slice(4), `bytes 4-${SIZE - 1}/${SIZE}`],
  ])("%s is 206 with those bytes", async (range, body, contentRange) => {
    const res = await read(range);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(contentRange);
    expect(res.headers.get("Content-Length")).toBe(String(body.length));
    expect(await res.text()).toBe(body);
  });

  test.each([`bytes=${SIZE}-`, `bytes=${SIZE + 5}-${SIZE + 9}`, "bytes=-0"])("%s is 416 naming the size", async (range) => {
    const res = await read(range);
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
    expect(await res.text()).toBe("");
  });

  test.each(["bytes=0-0", "bytes=0-", "bytes=-1"])("%s on an empty file is 416", async (range) => {
    const res = await read(range, "empty.txt");
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */0");
  });

  test.each(["bytes=5-2", "items=0-4", "bytes=0-1,4-5", "bytes=x-4", "bytes=-"])("%s is ignored: 200 with the whole body", async (range) => {
    const res = await read(range);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe(String(SIZE));
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a gzip-stored entry of unknown original size ignores Range rather than send 206 without a Content-Range", async () => {
    const res = await read("bytes=0-4", "assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(await res.text()).toBe(APP_JS);
  });
});
