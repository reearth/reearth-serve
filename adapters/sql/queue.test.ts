// `SqlJobQueue` against a real SQLite engine. It has to behave like the
// Cloudflare queue the consumers were written for: delayed messages stay
// invisible, `retry` redelivers with a higher attempt count, and a message
// that exhausts its attempts stops coming back (ADR-012 §4).
import { describe, expect, test } from "vitest";
import { createSqliteClient, DOMAIN_MIGRATIONS_DIR, SQL_ADAPTER_MIGRATIONS_DIR } from "../memory/sqlite-node";
import { SqlJobQueue } from "./queue";

type Msg = { id: string };

function fixture(options: { maxAttempts?: number } = {}) {
  const db = createSqliteClient(":memory:", [DOMAIN_MIGRATIONS_DIR, SQL_ADAPTER_MIGRATIONS_DIR]);
  let now = 1_700_000_000_000;
  const queue = new SqlJobQueue<Msg>(db, "extraction", { ...options, now: () => now });
  return { db, queue, advance: (seconds: number) => { now += seconds * 1000; } };
}

describe("SqlJobQueue", () => {
  test("send then receive delivers the body once", async () => {
    const { queue } = fixture();
    await queue.send({ id: "a" });

    const first = await queue.receive();
    expect(first.map((m) => m.body)).toEqual([{ id: "a" }]);
    expect(first[0].attempts).toBe(1);
    first[0].ack();
    await queue.flush();

    expect(await queue.receive()).toEqual([]);
    expect(await queue.depth()).toBe(0);
  });

  test("a delayed message is invisible until its time comes", async () => {
    const { queue, advance } = fixture();
    await queue.send({ id: "a" }, { delaySeconds: 30 });

    expect(await queue.receive()).toEqual([]);
    expect(await queue.depth()).toBe(1);

    advance(31);
    expect((await queue.receive()).map((m) => m.body)).toEqual([{ id: "a" }]);
  });

  test("retry redelivers after the delay with attempts incremented", async () => {
    const { queue, advance } = fixture();
    await queue.send({ id: "a" });

    const first = await queue.receive();
    first[0].retry({ delaySeconds: 10 });
    await queue.flush();

    expect(await queue.receive()).toEqual([]);
    advance(11);
    const second = await queue.receive();
    expect(second[0].attempts).toBe(2);
    expect(second[0].body).toEqual({ id: "a" });
  });

  test("a message that exhausts maxAttempts is dead-lettered, not requeued", async () => {
    const { queue } = fixture({ maxAttempts: 2 });
    await queue.send({ id: "a" });

    const first = await queue.receive();
    first[0].retry();
    await queue.flush();

    const second = await queue.receive();
    expect(second[0].attempts).toBe(2);
    second[0].retry();
    await queue.flush();

    expect(await queue.receive()).toEqual([]);
    expect(await queue.depth()).toBe(0);
    expect(queue.dead).toEqual([{ id: "a" }]);
  });

  test("only the named queue's messages are claimed", async () => {
    const { db, queue } = fixture();
    const other = new SqlJobQueue<Msg>(db, "thumbnail");
    await queue.send({ id: "a" });
    await other.send({ id: "b" });

    expect((await queue.receive()).map((m) => m.body)).toEqual([{ id: "a" }]);
    expect((await other.receive()).map((m) => m.body)).toEqual([{ id: "b" }]);
  });

  test("claiming removes the row, so a second drain sees nothing", async () => {
    const { db, queue } = fixture();
    const rival = new SqlJobQueue<Msg>(db, "extraction");
    await queue.send({ id: "a" });

    expect((await queue.receive()).length).toBe(1);
    expect(await rival.receive()).toEqual([]);
  });

  test("receive honours the batch limit and oldest-first order", async () => {
    const { queue } = fixture();
    await queue.send({ id: "a" });
    await queue.send({ id: "b" });
    await queue.send({ id: "c" });

    const batch = await queue.receive(2);
    expect(batch.map((m) => m.body.id)).toEqual(["a", "b"]);
    expect(await queue.depth()).toBe(1);
  });

  test("settling a message twice is a bug, not a silent double-write", async () => {
    const { queue } = fixture();
    await queue.send({ id: "a" });
    const [message] = await queue.receive();
    message.ack();
    expect(() => message.retry()).toThrow(/settled twice/);
  });
});
