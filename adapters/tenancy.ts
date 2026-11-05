import type { KeyValue } from "../core/kv/port";
import type { SqlClient } from "../core/sql/port";
import type { Tenancy } from "../core/tenancy/port";
import { CerbosAuthorizer } from "../core/auth/authorizer";
import { SimpleAuthorizer } from "../core/auth/permissions";
import { LocalTenancy } from "./sql/tenancy";

export type TenancyConfig =
  | { kind: "local" }
  | { kind: "cerbos"; endpoint: string }
  | { kind: "accounts"; baseUrl: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseTenancyConfig(env: {
  CERBOS_ENDPOINT?: string;
  ACCOUNTS_URL?: string;
  OIDC_ISSUER_URL?: string;
}): TenancyConfig {
  const { CERBOS_ENDPOINT: endpoint, ACCOUNTS_URL: accountsUrl } = env;
  if (accountsUrl) {
    if (endpoint) throw new Error("Set at most one of ACCOUNTS_URL and CERBOS_ENDPOINT");
    if (!env.OIDC_ISSUER_URL) throw new Error("ACCOUNTS_URL needs OIDC_ISSUER_URL, because accounts decides only for signed-in callers");
    const url = httpUrl(accountsUrl);
    if (!url) throw new Error("ACCOUNTS_URL must be an http or https URL");
    if (url.username || url.password || url.pathname !== "/" || /[?#]/.test(accountsUrl)) {
      throw new Error("ACCOUNTS_URL must be an origin, with no userinfo, path, query or fragment");
    }
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error("ACCOUNTS_URL must use https unless its host is localhost, 127.0.0.1 or [::1]");
    }
    return { kind: "accounts", baseUrl: url.origin };
  }
  if (!endpoint) return { kind: "local" };
  if (!httpUrl(endpoint)) throw new Error("CERBOS_ENDPOINT must be an http or https URL");
  return { kind: "cerbos", endpoint };
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function buildTenancy(config: TenancyConfig, deps: { sql: SqlClient; kv: KeyValue }): Tenancy {
  switch (config.kind) {
    case "local":
      return new LocalTenancy(deps.sql, new SimpleAuthorizer());
    case "cerbos":
      return new LocalTenancy(deps.sql, new CerbosAuthorizer(config.endpoint));
    case "accounts":
      return lazyAccountsTenancy(config.baseUrl, deps.kv);
  }
}

function lazyAccountsTenancy(baseUrl: string, kv: KeyValue): Tenancy {
  let loaded: Promise<Tenancy> | null = null;
  return {
    async enter(caller) {
      loaded ??= import("./accounts").then(
        ({ accountsTenancy }) => accountsTenancy({ baseUrl, kv }),
        (error: unknown) => {
          loaded = null;
          throw error;
        },
      );
      return (await loaded).enter(caller);
    },
  };
}
