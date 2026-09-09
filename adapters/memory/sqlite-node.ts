/**
 * `SqlClient` over Node's built-in SQLite (`node:sqlite`).
 *
 * This is the provider-independent implementation used by unit tests today and
 * by the Node runtime later (ADR-012 §5 step 7). It never runs inside the
 * Worker bundle — `node:sqlite` is not available there.
 *
 * Node 22 hides `node:sqlite` behind `--experimental-sqlite`; the vitest config
 * passes that flag so the same code runs on Node 22 (CI) and Node 24+ (local).
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Row, SqlClient, SqlResult, SqlStatement, SqlValue } from "../../core/sql/port";

// node:sqlite binds anonymous and numbered (`?1`) parameters positionally, but
// only accepts null / number / bigint / string / Uint8Array values.
type BindValue = null | number | bigint | string | Uint8Array;

function toBindValue(value: SqlValue | undefined): BindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

// Statements that produce rows must go through `all()`; everything else through
// `run()`, which is the only call that reports `changes`.
const READ_ONLY = /^\s*(?:SELECT|WITH|PRAGMA|VALUES)\b/i;
const RETURNING = /\bRETURNING\b/i;

export class NodeSqlClient implements SqlClient {
  constructor(private db: DatabaseSync) {}

  async execute(sql: string, args?: SqlValue[]): Promise<SqlResult> {
    return this.executeSync(sql, args);
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    if (statements.length === 0) return [];
    // Unlike D1, node:sqlite has real transactions — use one so a failing
    // statement rolls the earlier ones back, matching D1's atomic batch().
    this.db.exec("BEGIN");
    try {
      const results = statements.map((s) => this.executeSync(s.sql, s.args));
      this.db.exec("COMMIT");
      return results;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private executeSync(sql: string, args?: SqlValue[]): SqlResult {
    const stmt = this.db.prepare(sql);
    const bound = (args ?? []).map(toBindValue);
    if (READ_ONLY.test(sql)) {
      // D1 reports meta.changes = 0 for reads; sqlite's changes() is sticky.
      return { rows: stmt.all(...bound) as Row[], rowsAffected: 0 };
    }
    if (RETURNING.test(sql)) {
      const rows = stmt.all(...bound) as Row[];
      return { rows, rowsAffected: this.changes() };
    }
    const info = stmt.run(...bound);
    return { rows: [], rowsAffected: Number(info.changes) };
  }

  private changes(): number {
    const row = this.db.prepare("SELECT changes() AS c").get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  }
}

/** Apply every `*.sql` file in `dir`, in filename order. */
export function applyMigrations(db: DatabaseSync, dir: string): void {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
}

/** The domain schema every backend shares (D1 applies it via wrangler). */
export const DOMAIN_MIGRATIONS_DIR = fileURLToPath(
  new URL("../cloudflare/migrations", import.meta.url),
);

/**
 * Tables that only exist where Cloudflare KV and Queues do not: `kv` and
 * `queue_messages`. Kept out of the D1 migrations on purpose — see the
 * migration file's header.
 */
export const SQL_ADAPTER_MIGRATIONS_DIR = fileURLToPath(
  new URL("../sql/migrations", import.meta.url),
);

/**
 * A database with the given migration directories applied, in order — the
 * repository layer's test fixture, and the shape the Node runtime uses with a
 * file path instead of `:memory:`.
 *
 * Defaults to the domain schema only, so a test that wants `SqlKeyValue` or
 * `SqlJobQueue` asks for `SQL_ADAPTER_MIGRATIONS_DIR` explicitly.
 */
export function createSqliteClient(
  path = ":memory:",
  migrations: string | string[] = DOMAIN_MIGRATIONS_DIR,
): NodeSqlClient {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of typeof migrations === "string" ? [migrations] : migrations) {
    applyMigrations(db, dir);
  }
  return new NodeSqlClient(db);
}
