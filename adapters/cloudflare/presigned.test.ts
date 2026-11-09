import { describe, expect, test } from "vitest";
import { R2PresignedUrlGenerator } from "./presigned";

const generator = new R2PresignedUrlGenerator({
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  bucket: "bkt",
});

async function putPath(key: string): Promise<URL> {
  return new URL((await generator.generatePutUrl(key, "text/plain", 60)).url);
}

describe("R2PresignedUrlGenerator object URLs", () => {
  test("a dot-segment filename stays inside the asset prefix", async () => {
    const url = await putPath("assets/abc/%2e%2e");
    expect(url.pathname).toBe("/bkt/assets/abc/%252e%252e");
  });

  test("query and fragment characters stay part of the key", async () => {
    const url = await putPath("assets/abc/a?x=1#b");
    expect(url.pathname).toBe("/bkt/assets/abc/a%3Fx%3D1%23b");
    expect(url.searchParams.has("x")).toBe(false);
  });

  test("ordinary filenames keep their usual encoding", async () => {
    const url = await putPath("assets/abc/my file.json");
    expect(url.pathname).toBe("/bkt/assets/abc/my%20file.json");
  });
});

describe("R2PresignedUrlGenerator checksum (ADR-017 §2)", () => {
  // sha256("hello")
  const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  test("a declared sha256 is signed in as x-amz-checksum-sha256 and returned for the client", async () => {
    const put = await generator.generatePutUrl("assets/abc/a.txt", "text/plain", 60, { sha256: HELLO });
    const url = new URL(put.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("x-amz-checksum-sha256");
    expect(put.headers).toEqual({ "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=" });
  });

  test("without a declared sha256 no checksum header is signed or returned", async () => {
    const put = await generator.generatePutUrl("assets/abc/a.txt", "text/plain", 60);
    expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(put.headers).toEqual({});
  });
});
