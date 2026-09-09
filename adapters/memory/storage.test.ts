// `MemoryFileStorage` has to behave enough like R2 that the use cases cannot
// tell the difference: ranged reads, prefix listing with a cursor, and a body
// that must match its declared Content-Length (ADR-012 §1).
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "./storage";

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

async function read(body: ReadableStream): Promise<string> {
  return new TextDecoder().decode(await new Response(body).arrayBuffer());
}

describe("MemoryFileStorage", () => {
  test("round-trips a multi-chunk body", async () => {
    const storage = new MemoryFileStorage();
    await storage.put("a/b.txt", stream(bytes("hello "), bytes("world")), "text/plain", 11);

    const file = await storage.get("a/b.txt");
    expect(file).not.toBeNull();
    expect(file!.size).toBe(11);
    expect(file!.contentType).toBe("text/plain");
    expect(await read(file!.body)).toBe("hello world");
  });

  test("a missing key reads as null", async () => {
    const storage = new MemoryFileStorage();
    expect(await storage.get("nope")).toBeNull();
    expect(await storage.head("nope")).toBeNull();
  });

  test("head reports size, encoding and a content-dependent etag", async () => {
    const storage = new MemoryFileStorage();
    await storage.put("a", stream(bytes("hello")), "text/plain", 5, { contentEncoding: "gzip" });
    await storage.put("b", stream(bytes("world")), "text/plain", 5);

    const a = await storage.head("a");
    const b = await storage.head("b");
    expect(a).toEqual({ size: 5, contentEncoding: "gzip", etag: expect.any(String) });
    expect(a!.etag).not.toBe(b!.etag);
  });

  test("a ranged get returns the slice and the full object size", async () => {
    const storage = new MemoryFileStorage();
    await storage.put("a", stream(bytes("0123456789")), "text/plain", 10);

    const file = await storage.get("a", { offset: 3, length: 4 });
    expect(await read(file!.body)).toBe("3456");
    expect(file!.size).toBe(10);
    expect(file!.range).toEqual({ offset: 3, length: 4, totalSize: 10 });
  });

  test("a range running past the end is clamped", async () => {
    const storage = new MemoryFileStorage();
    await storage.put("a", stream(bytes("0123456789")), "text/plain", 10);

    const file = await storage.get("a", { offset: 8, length: Number.MAX_SAFE_INTEGER });
    expect(await read(file!.body)).toBe("89");
    expect(file!.range!.length).toBe(2);
  });

  test("a body longer than Content-Length is rejected with a 400-able message", async () => {
    const storage = new MemoryFileStorage();
    await expect(
      storage.put("a", stream(bytes("too long")), "text/plain", 3),
    ).rejects.toThrow(/declared Content-Length/);
    expect(storage.size).toBe(0);
  });

  test("a body shorter than Content-Length is rejected too", async () => {
    const storage = new MemoryFileStorage();
    await expect(
      storage.put("a", stream(bytes("hi")), "text/plain", 10),
    ).rejects.toThrow(/declared Content-Length/);
  });

  test("list filters by prefix and pages with a cursor", async () => {
    const storage = new MemoryFileStorage();
    for (const key of ["p/1", "p/2", "p/3", "q/1"]) {
      await storage.put(key, stream(bytes("x")), "text/plain", 1);
    }

    const first = await storage.list("p/", { limit: 2 });
    expect(first.keys).toEqual(["p/1", "p/2"]);
    expect(first.cursor).toBe("p/2");

    const second = await storage.list("p/", { limit: 2, cursor: first.cursor });
    expect(second.keys).toEqual(["p/3"]);
    expect(second.cursor).toBeUndefined();
  });

  test("delete and deleteMany remove objects", async () => {
    const storage = new MemoryFileStorage();
    for (const key of ["a", "b", "c"]) {
      await storage.put(key, stream(bytes("x")), "text/plain", 1);
    }
    await storage.delete("a");
    await storage.deleteMany(["b", "missing"]);
    expect(storage.size).toBe(1);
    expect(await storage.get("c")).not.toBeNull();
  });
});
