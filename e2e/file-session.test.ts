import { describe, test, expect, beforeAll } from "vitest";
import { BASE, uploadFile } from "./helpers";

describe("File delivery never touches a session", () => {
  const content = "0123456789abcdef";
  let fileUrl: string;

  beforeAll(async () => {
    const upload = await uploadFile(new TextEncoder().encode(content), "a.txt", "text/plain");
    expect(upload.status).toBe(201);
    expect(upload.sessionId).toMatch(/^[0-9a-f]{16}$/);
    fileUrl = `${BASE}/files/${upload.body.asset.id}/a.txt`;
  });

  test("GET", async () => {
    const res = await fetch(fileUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
    expect(res.headers.get("X-Session-Id")).toBeNull();
  });

  test("HEAD", async () => {
    const res = await fetch(fileUrl, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(content.length));
    expect(res.headers.get("X-Session-Id")).toBeNull();
  });

  test("Range", async () => {
    const res = await fetch(fileUrl, { headers: { Range: "bytes=4-7" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 4-7/${content.length}`);
    expect(await res.text()).toBe("4567");
    expect(res.headers.get("X-Session-Id")).toBeNull();
  });

  test("thumbnail", async () => {
    const res = await fetch(`${fileUrl}?thumb=xs`);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Session-Id")).toBeNull();
  });

  test("malformed X-Session-Id is ignored", async () => {
    const res = await fetch(fileUrl, { headers: { "X-Session-Id": "not-a-session" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
    expect(res.headers.get("X-Session-Id")).toBeNull();
  });
});
