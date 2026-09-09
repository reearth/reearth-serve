import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { NodeSqlClient, createSqliteClient } from "./sqlite-node";

function client(): NodeSqlClient {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)");
  return new NodeSqlClient(db);
}

describe("NodeSqlClient", () => {
  test("execute reports rows for reads and rowsAffected for writes", async () => {
    const sql = client();
    expect(await sql.execute("INSERT INTO t (id, n) VALUES (?1, ?2)", ["a", 1]))
      .toEqual({ rows: [], rowsAffected: 1 });
    expect(await sql.execute("SELECT * FROM t")).toEqual({ rows: [{ id: "a", n: 1 }], rowsAffected: 0 });
    expect((await sql.execute("UPDATE t SET n = 2")).rowsAffected).toBe(1);
    expect((await sql.execute("DELETE FROM t WHERE id = ?1", ["missing"])).rowsAffected).toBe(0);
  });

  test("execute returns the rows of a RETURNING clause", async () => {
    const sql = client();
    const { rows } = await sql.execute("INSERT INTO t (id, n) VALUES (?1, ?2) RETURNING n", ["a", 7]);
    expect(rows).toEqual([{ n: 7 }]);
  });

  test("batch runs every statement and returns one result each", async () => {
    const sql = client();
    const results = await sql.batch([
      { sql: "INSERT INTO t (id, n) VALUES (?1, ?2)", args: ["a", 1] },
      { sql: "INSERT INTO t (id, n) VALUES (?1, ?2)", args: ["b", 2] },
      { sql: "SELECT COUNT(*) AS c FROM t" },
    ]);
    expect(results).toHaveLength(3);
    expect(results[2].rows).toEqual([{ c: 2 }]);
  });

  test("batch rolls the earlier statements back when one fails", async () => {
    const sql = client();
    await sql.execute("INSERT INTO t (id, n) VALUES (?1, ?2)", ["dup", 0]);

    await expect(
      sql.batch([
        { sql: "INSERT INTO t (id, n) VALUES (?1, ?2)", args: ["fresh", 1] },
        // Primary-key collision: the whole batch must be discarded.
        { sql: "INSERT INTO t (id, n) VALUES (?1, ?2)", args: ["dup", 2] },
      ]),
    ).rejects.toThrow();

    const { rows } = await sql.execute("SELECT id FROM t ORDER BY id");
    expect(rows).toEqual([{ id: "dup" }]);
    // The transaction was closed, not left open.
    await expect(sql.execute("INSERT INTO t (id, n) VALUES (?1, ?2)", ["after", 3])).resolves.toBeTruthy();
  });

  test("batch of no statements is a no-op", async () => {
    expect(await client().batch([])).toEqual([]);
  });

  test("createSqliteClient applies the migrations", async () => {
    const sql = createSqliteClient();
    const { rows } = await sql.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["assets", "asset_versions", "cleanup_pending", "jobs", "members", "projects", "storage_usage", "workspaces"]),
    );
  });
});
