import { describe, test, expect } from "vitest";
import { MemoryKeyValue } from "../infra/memory-kv";
import { KeyValueSessionStore, KeyValueUploadSessionStore } from "./stores";
import type { UploadSession } from "../asset/model";

/** Clock a test can move by hand, so TTLs are asserted without sleeping. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceSeconds(seconds: number) {
      now += seconds * 1000;
    },
  };
}

describe("MemoryKeyValue", () => {
  test("round-trips a value and misses on an unknown key", async () => {
    const kv = new MemoryKeyValue();
    expect(await kv.get("missing")).toBeNull();

    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  test("put overwrites, delete removes", async () => {
    const kv = new MemoryKeyValue();
    await kv.put("k", "one");
    await kv.put("k", "two");
    expect(await kv.get("k")).toBe("two");

    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
    // Deleting again is not an error.
    await kv.delete("k");
  });

  test("a value with a TTL disappears once the clock passes it", async () => {
    const clock = fakeClock();
    const kv = new MemoryKeyValue({ now: clock.now });

    await kv.put("k", "v", { ttlSeconds: 60 });
    clock.advanceSeconds(59);
    expect(await kv.get("k")).toBe("v");
    expect(kv.size).toBe(1);

    clock.advanceSeconds(1);
    expect(await kv.get("k")).toBeNull();
    expect(kv.size).toBe(0);
  });

  test("a value without a TTL outlives one that has it", async () => {
    const clock = fakeClock();
    const kv = new MemoryKeyValue({ now: clock.now });

    await kv.put("forever", "v");
    await kv.put("fleeting", "v", { ttlSeconds: 10 });

    clock.advanceSeconds(3600);
    expect(await kv.get("forever")).toBe("v");
    expect(await kv.get("fleeting")).toBeNull();
  });

  test("re-putting a key resets its TTL", async () => {
    const clock = fakeClock();
    const kv = new MemoryKeyValue({ now: clock.now });

    await kv.put("k", "v", { ttlSeconds: 60 });
    clock.advanceSeconds(50);
    await kv.put("k", "v2", { ttlSeconds: 60 });

    clock.advanceSeconds(50);
    expect(await kv.get("k")).toBe("v2");
  });
});

function makeUploadSession(id: string): UploadSession {
  return {
    id,
    filename: "a.zip",
    contentType: "application/zip",
    size: 10,
    createdAt: 0,
    expiresAt: 3_600_000,
    s3UploadId: "u1",
  };
}

describe("KeyValueUploadSessionStore", () => {
  test("saves, finds and deletes over the port", async () => {
    const kv = new MemoryKeyValue();
    const store = new KeyValueUploadSessionStore(kv);

    await store.save(makeUploadSession("s1"), 3600);
    expect(await store.find("s1")).toMatchObject({ id: "s1", s3UploadId: "u1" });
    expect(await store.find("nope")).toBeNull();

    await store.delete("s1");
    expect(await store.find("s1")).toBeNull();
  });

  test("an upload session stops resolving once its TTL passes", async () => {
    const clock = fakeClock();
    const store = new KeyValueUploadSessionStore(new MemoryKeyValue({ now: clock.now }));

    await store.save(makeUploadSession("s1"), 60);
    clock.advanceSeconds(61);
    expect(await store.find("s1")).toBeNull();
  });

  test("keeps the upload: key prefix so existing entries keep resolving", async () => {
    const kv = new MemoryKeyValue();
    await new KeyValueUploadSessionStore(kv).save(makeUploadSession("s1"), 60);
    expect(await kv.get("upload:s1")).not.toBeNull();
  });
});

describe("KeyValueSessionStore", () => {
  test("saves and finds over the port", async () => {
    const kv = new MemoryKeyValue();
    const store = new KeyValueSessionStore(kv);

    await store.save({ id: "sess1", createdAt: 1, expiresAt: 2 }, 3600);
    expect(await store.find("sess1")).toEqual({ id: "sess1", createdAt: 1, expiresAt: 2 });
    expect(await store.find("other")).toBeNull();
  });

  test("a session stops resolving once its TTL passes", async () => {
    const clock = fakeClock();
    const store = new KeyValueSessionStore(new MemoryKeyValue({ now: clock.now }));

    await store.save({ id: "sess1", createdAt: 0, expiresAt: 60_000 }, 60);
    clock.advanceSeconds(30);
    expect(await store.find("sess1")).not.toBeNull();

    clock.advanceSeconds(31);
    expect(await store.find("sess1")).toBeNull();
  });

  test("keeps the session: key prefix so existing entries keep resolving", async () => {
    const kv = new MemoryKeyValue();
    await new KeyValueSessionStore(kv).save({ id: "sess1", createdAt: 0, expiresAt: 1 }, 60);
    expect(await kv.get("session:sess1")).not.toBeNull();
  });
});
