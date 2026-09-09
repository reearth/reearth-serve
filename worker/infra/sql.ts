/**
 * The SQL port (ADR-012 §3).
 *
 * The dialect is SQLite and only SQLite: the SQL strings in the repository
 * layer are never rewritten, only the transport changes. On Cloudflare the
 * implementation wraps D1; off Cloudflare it is a Hrana client or the
 * `node:sqlite` client in `sqlite-node.ts`.
 */

export type SqlValue = string | number | bigint | boolean | null | ArrayBuffer | Uint8Array;

export type Row = Record<string, unknown>;

export interface SqlStatement {
  sql: string;
  args?: SqlValue[];
}

export interface SqlResult {
  rows: Row[];
  /** Rows written by the statement (D1 `meta.changes`). Zero for reads. */
  rowsAffected: number;
}

export interface SqlClient {
  execute(sql: string, args?: SqlValue[]): Promise<SqlResult>;
  /**
   * Executes all statements atomically. There is no interactive transaction:
   * D1 offers only `batch()`, and Hrana's `batch` matches it. Implementations
   * that do have transactions (see `sqlite-node.ts`) must still roll the whole
   * list back if any statement fails.
   */
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

/** `SqlClient` over a Cloudflare D1 binding. */
export class D1SqlClient implements SqlClient {
  constructor(private db: D1Database) {}

  async execute(sql: string, args?: SqlValue[]): Promise<SqlResult> {
    const result = await this.prepare(sql, args).all();
    return toResult(result);
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    if (statements.length === 0) return [];
    const results = await this.db.batch(
      statements.map((s) => this.prepare(s.sql, s.args)),
    );
    return results.map(toResult);
  }

  private prepare(sql: string, args?: SqlValue[]): D1PreparedStatement {
    const stmt = this.db.prepare(sql);
    return args && args.length > 0 ? stmt.bind(...args) : stmt;
  }
}

function toResult(result: D1Result): SqlResult {
  return {
    rows: (result.results ?? []) as Row[],
    rowsAffected: result.meta?.changes ?? 0,
  };
}
