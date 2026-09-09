/**
 * The SQL port (ADR-012 §3).
 *
 * The dialect is SQLite and only SQLite: the SQL strings in the repository
 * layer are never rewritten, only the transport changes. On Cloudflare the
 * implementation wraps D1 (`adapters/cloudflare/sql.ts`); off Cloudflare it is
 * a Hrana client or the `node:sqlite` client in
 * `adapters/memory/sqlite-node.ts`.
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
   * that do have transactions (see `adapters/memory/sqlite-node.ts`) must still
   * roll the whole list back if any statement fails.
   */
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}
