import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOMAIN_MIGRATIONS, MigrationDrift, NODE_MIGRATIONS, NodeSqlClient, UnledgeredDatabase,
  createSqliteClient, type MigrationSource,
} from "./sqlite-node";

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

describe("createSqliteClient migration ledger", () => {
  const dirs: string[] = [];
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "serve-ledger-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function copyOf(source: MigrationSource): MigrationSource {
    const dir = tempDir();
    cpSync(source.dir, dir, { recursive: true });
    return { set: source.set, dir };
  }

  async function tables(sql: NodeSqlClient): Promise<string[]> {
    const { rows } = await sql.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    );
    return rows.map((r) => String(r.name));
  }

  async function ledger(sql: NodeSqlClient): Promise<string[]> {
    const { rows } = await sql.execute("SELECT set_name, name FROM _serve_migrations ORDER BY set_name, name");
    return rows.map((r) => `${r.set_name}/${r.name}`);
  }

  test("a file database reopens: the second boot applies nothing and keeps the data", async () => {
    const path = join(tempDir(), "serve.sqlite");
    const sources = [DOMAIN_MIGRATIONS, NODE_MIGRATIONS];

    const first = createSqliteClient(path, sources);
    await first.execute("INSERT INTO kv (key, value) VALUES (?1, ?2)", ["k", "v"]);
    const appliedFirst = await ledger(first);
    expect(appliedFirst).toContain("node/0001_create_queue_and_kv.sql");
    expect(appliedFirst).toContain("domain/0001_create_initial_tables.sql");

    const second = createSqliteClient(path, sources);
    expect(await ledger(second)).toEqual(appliedFirst);
    expect((await second.execute("SELECT value FROM kv WHERE key = ?1", ["k"])).rows).toEqual([{ value: "v" }]);
  });

  test("a later boot applies only the files added since", async () => {
    const path = join(tempDir(), "serve.sqlite");
    const source = copyOf(NODE_MIGRATIONS);
    createSqliteClient(path, [source]);

    writeFileSync(join(source.dir, "9999_extra.sql"), "CREATE TABLE extra (id TEXT PRIMARY KEY);");
    const sql = createSqliteClient(path, [source]);
    expect(await tables(sql)).toContain("extra");
    expect(await ledger(sql)).toContain("node/9999_extra.sql");
  });

  test("an applied file that was edited fails with MigrationDrift naming set and file", () => {
    const path = join(tempDir(), "serve.sqlite");
    const source = copyOf(DOMAIN_MIGRATIONS);
    createSqliteClient(path, [source]);

    appendFileSync(join(source.dir, "0003_add_cleanup_pending.sql"), "\n-- edited\n");
    let error: unknown;
    try {
      createSqliteClient(path, [source]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationDrift);
    expect(error).toMatchObject({ set: "domain", file: "0003_add_cleanup_pending.sql" });
  });

  test("a file that fails halfway leaves no ledger row and no partial table", async () => {
    const path = join(tempDir(), "serve.sqlite");
    const dir = tempDir();
    writeFileSync(join(dir, "0001_good.sql"), "CREATE TABLE good (id TEXT);");
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE half (id TEXT);\nINSERT INTO missing VALUES (1);");
    const source: MigrationSource = { set: "node", dir };

    expect(() => createSqliteClient(path, [source])).toThrow(/missing/);

    const sql = new NodeSqlClient(new DatabaseSync(path));
    expect(await tables(sql)).toEqual(["_serve_migrations", "good"]);
    expect(await ledger(sql)).toEqual(["node/0001_good.sql"]);
  });

  test("a database with tables but no ledger is refused", () => {
    const path = join(tempDir(), "serve.sqlite");
    new DatabaseSync(path).exec("CREATE TABLE assets (id TEXT PRIMARY KEY)");
    expect(() => createSqliteClient(path)).toThrow(UnledgeredDatabase);
  });

  test("files other than .sql in a migration directory are ignored", async () => {
    const source = copyOf(NODE_MIGRATIONS);
    writeFileSync(join(source.dir, "atlas.sum"), "h1:not-sql\n");
    writeFileSync(join(source.dir, "README.md"), "# not sql\n");
    const sql = createSqliteClient(":memory:", [source]);
    expect(await ledger(sql)).toEqual(["node/0001_create_queue_and_kv.sql"]);
  });
});
