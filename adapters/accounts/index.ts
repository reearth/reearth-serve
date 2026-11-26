import type { KeyValue } from "../../core/kv/port";
import type { Tenancy } from "../../core/tenancy/port";
import { AccountsClient } from "./client";
import { AccountsTenancy } from "./tenancy";

export { AccountsClient, type ResourceCheck, type WorkspaceAlias } from "./client";
export { ACCOUNTS_SERVICE, fromAccountsRole, toAccountsRole } from "./roles";

export function accountsTenancy(opts: { baseUrl: string; kv: KeyValue }): Tenancy {
  return new AccountsTenancy({ client: new AccountsClient(opts.baseUrl), kv: opts.kv });
}
