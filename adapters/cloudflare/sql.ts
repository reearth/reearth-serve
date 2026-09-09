/**
 * The Cloudflare D1 implementation of the `SqlClient` port
 * (`core/sql/port.ts`, ADR-012 §3).
 */

import type { Row, SqlClient, SqlResult, SqlStatement, SqlValue } from "../../core/sql/port";

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
