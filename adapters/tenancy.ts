import type { SqlClient } from "../core/sql/port";
import type { Tenancy } from "../core/tenancy/port";
import { CerbosAuthorizer } from "../core/auth/authorizer";
import { SimpleAuthorizer } from "../core/auth/permissions";
import { LocalTenancy } from "./sql/tenancy";

export type TenancyConfig =
  | { kind: "local" }
  | { kind: "cerbos"; endpoint: string };

export function parseTenancyConfig(env: { CERBOS_ENDPOINT?: string }): TenancyConfig {
  const endpoint = env.CERBOS_ENDPOINT;
  if (!endpoint) return { kind: "local" };
  if (!isHttpUrl(endpoint)) throw new Error("CERBOS_ENDPOINT must be an http or https URL");
  return { kind: "cerbos", endpoint };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function buildTenancy(config: TenancyConfig, deps: { sql: SqlClient }): Tenancy {
  switch (config.kind) {
    case "local":
      return new LocalTenancy(deps.sql, new SimpleAuthorizer());
    case "cerbos":
      return new LocalTenancy(deps.sql, new CerbosAuthorizer(config.endpoint));
  }
}
