import { describe, expect, test } from "vitest";
import { R2PresignedUrlGenerator } from "./presigned";

const generator = new R2PresignedUrlGenerator({
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  bucket: "bkt",
});

async function putPath(key: string): Promise<URL> {
  return new URL(await generator.generatePutUrl(key, "text/plain", 60));
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
