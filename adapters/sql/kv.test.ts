// `SqlKeyValue` against a real SQLite engine. The contract it has to match is
// Cloudflare KV's: an expired value is never returned, and a TTL-less value
// stays forever (ADR-012 §2).
import { describe, expect, test } from "vitest";
import { createSqliteClient, DOMAIN_MIGRATIONS_DIR, SQL_ADAPTER_MIGRATIONS_DIR } from "../memory/sqlite-node";
import { SqlKeyValue } from "./kv";

function fixture() {
  const db = createSqliteClient(":memory:", [DOMAIN_MIGRATIONS_DIR, SQL_ADAPTER_MIGRATIONS_DIR]);
  let now = 1_700_000_000_000;
  const kv = new SqlKeyValue(db, { now: () => now });
  return { db, kv, advance: (seconds: number) => { now += seconds * 1000; } };
}

describe("SqlKeyValue", () => {
  test("round-trips a value and overwrites it", async () => {
    const { kv } = fixture();
    expect(await kv.get("a")).toBeNull();
    await kv.put("a", "one");
    expect(await kv.get("a")).toBe("one");
    await kv.put("a", "two");
    expect(await kv.get("a")).toBe("two");
  });

  test("deletes", async () => {
    const { kv } = fixture();
    await kv.put("a", "one");
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  test("a value without a TTL never expires", async () => {
    const { kv, advance } = fixture();
    await kv.put("a", "one");
    advance(10 * 365 * 24 * 3600);
    expect(await kv.get("a")).toBe("one");
  });

  test("an expired value is invisible before it is swept", async () => {
    const { kv, advance } = fixture();
    await kv.put("a", "one", { ttlSeconds: 60 });
    advance(59);
    expect(await kv.get("a")).toBe("one");
    advance(2);
    expect(await kv.get("a")).toBeNull();
  });

  test("sweepExpired removes only expired rows", async () => {
    const { db, kv, advance } = fixture();
    await kv.put("gone", "x", { ttlSeconds: 60 });
    await kv.put("live", "y", { ttlSeconds: 600 });
    await kv.put("forever", "z");
    advance(120);

    expect(await kv.sweepExpired()).toBe(1);
    const { rows } = await db.execute("SELECT key FROM kv ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual(["forever", "live"]);
  });

  test("re-putting an expired key revives it with a fresh TTL", async () => {
    const { kv, advance } = fixture();
    await kv.put("a", "one", { ttlSeconds: 60 });
    advance(120);
    await kv.put("a", "two", { ttlSeconds: 60 });
    expect(await kv.get("a")).toBe("two");
  });
});
