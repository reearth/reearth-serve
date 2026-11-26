import type { KeyValue } from "../../core/kv/port";
import type { VerifiedCaller } from "../../core/auth/types";
import { TenancyUnavailableError } from "../../core/tenancy/port";
import { ACCOUNTS_TIMEOUT_MS, type AccountsClient } from "./client";

export const KV_TTL_SECONDS = 3600;
const MEMORY_MAX_ENTRIES = 10_000;

type CachedId = { id: string; expiresAt: number };

export type IdentityMemory = {
  ids: Map<string, CachedId>;
  inflight: Map<string, Promise<string>>;
};

export function identityMemory(): IdentityMemory {
  return { ids: new Map(), inflight: new Map() };
}

const isolateMemory = identityMemory();

type IdentityDeps = { client: Pick<AccountsClient, "me">; kv: KeyValue; memory?: IdentityMemory };

function kvKey(sub: string): string {
  return `accounts:user-id:${sub}`;
}

function parseCached(raw: string | null): CachedId | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" && value !== null &&
      "id" in value && typeof value.id === "string" &&
      "expiresAt" in value && typeof value.expiresAt === "number"
    ) {
      return { id: value.id, expiresAt: value.expiresAt };
    }
  } catch {
    return null;
  }
  return null;
}

function remember(ids: IdentityMemory["ids"], sub: string, cached: CachedId): void {
  ids.delete(sub);
  ids.set(sub, cached);
  if (ids.size > MEMORY_MAX_ENTRIES) {
    const oldest = ids.keys().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
}

async function lookUp(caller: VerifiedCaller, deps: IdentityDeps, memory: IdentityMemory): Promise<string> {
  const now = Date.now();
  const inKv = parseCached(await deps.kv.get(kvKey(caller.sub)).catch(() => null));
  if (inKv && inKv.expiresAt > now) {
    remember(memory.ids, caller.sub, inKv);
    return inKv.id;
  }

  const id = await deps.client.me(caller.credential);
  const cached = { id, expiresAt: now + KV_TTL_SECONDS * 1000 };
  remember(memory.ids, caller.sub, cached);
  await deps.kv
    .put(kvKey(caller.sub), JSON.stringify(cached), { ttlSeconds: KV_TTL_SECONDS })
    .catch((e: unknown) => console.warn("Failed to cache the accounts user id:", e));
  return id;
}

export async function resolveAccountsUserId(caller: VerifiedCaller, deps: IdentityDeps): Promise<string> {
  const memory = deps.memory ?? isolateMemory;
  const inMemory = memory.ids.get(caller.sub);
  if (inMemory && inMemory.expiresAt > Date.now()) return inMemory.id;

  const shared = memory.inflight.get(caller.sub);
  if (shared) return join(shared, () => evict(memory, caller.sub, shared));

  const pending: Promise<string> = lookUp(caller, deps, memory).finally(() => evict(memory, caller.sub, pending));
  memory.inflight.set(caller.sub, pending);
  return pending;
}

function evict(memory: IdentityMemory, sub: string, pending: Promise<string>): void {
  if (memory.inflight.get(sub) === pending) memory.inflight.delete(sub);
}

/** The lookup belongs to another request, which a Worker may cancel before it settles. */
async function join(shared: Promise<string>, onExpiry: () => void): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpiry();
      reject(new TenancyUnavailableError("The shared accounts user id lookup did not settle"));
    }, ACCOUNTS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([shared, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function forgetAccountsUserId(sub: string, deps: Omit<IdentityDeps, "client">): Promise<void> {
  (deps.memory ?? isolateMemory).ids.delete(sub);
  await deps.kv.delete(kvKey(sub)).catch((e: unknown) => console.warn("Failed to evict the accounts user id:", e));
}

if (import.meta.vitest) {
  const { test, expect, vi, describe, beforeEach, afterEach } = import.meta.vitest;
  const { MemoryKeyValue } = await import("../memory/memory-kv");
  const { BearerCredential } = await import("../../core/auth/types");
  const { UnknownAccountError } = await import("../../core/tenancy/port");

  const caller: VerifiedCaller = { kind: "user", sub: "idp|alice", credential: new BearerCredential("t") };
  const ONE_HOUR_MS = 3_600_000;
  const NOW = 1_000_000;

  function setup(me: () => Promise<string> = async () => "acc-1") {
    return { client: { me: vi.fn(me) }, kv: new MemoryKeyValue(), memory: identityMemory() };
  }

  describe("resolveAccountsUserId", () => {
    beforeEach(() => vi.useFakeTimers({ now: NOW }));
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    test("a miss asks accounts once, then memory answers", async () => {
      const deps = setup();
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(deps.client.me).toHaveBeenCalledOnce();
    });

    test("a KV hit answers a fresh isolate without asking accounts", async () => {
      const deps = setup();
      await resolveAccountsUserId(caller, deps);
      const freshIsolate = { ...deps, memory: identityMemory() };
      expect(await resolveAccountsUserId(caller, freshIsolate)).toBe("acc-1");
      expect(deps.client.me).toHaveBeenCalledOnce();
      expect(freshIsolate.memory.ids.get(caller.sub)?.id).toBe("acc-1");
    });

    test("a fetch is cached for exactly one hour in KV and in memory", async () => {
      const deps = setup();
      const put = vi.spyOn(deps.kv, "put");
      await resolveAccountsUserId(caller, deps);
      expect(put).toHaveBeenCalledExactlyOnceWith(
        "accounts:user-id:idp|alice",
        JSON.stringify({ id: "acc-1", expiresAt: NOW + ONE_HOUR_MS }),
        { ttlSeconds: 3600 },
      );
      vi.advanceTimersByTime(ONE_HOUR_MS - 1);
      await resolveAccountsUserId(caller, { ...deps, memory: identityMemory() });
      await resolveAccountsUserId(caller, deps);
      expect(deps.client.me).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      await resolveAccountsUserId(caller, deps);
      expect(deps.client.me).toHaveBeenCalledTimes(2);
    });

    test("a KV hit keeps the KV expiry in memory instead of extending it", async () => {
      const deps = setup();
      await deps.kv.put(kvKey(caller.sub), JSON.stringify({ id: "acc-1", expiresAt: NOW + 60_000 }));
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(deps.client.me).not.toHaveBeenCalled();
      expect(deps.memory.ids.get(caller.sub)?.expiresAt).toBe(NOW + 60_000);
      await deps.kv.delete(kvKey(caller.sub));
      vi.advanceTimersByTime(60_000);
      await resolveAccountsUserId(caller, deps);
      expect(deps.client.me).toHaveBeenCalledOnce();
    });

    test("memory holds at most 10,000 subs and drops the oldest first", async () => {
      const deps = setup();
      const user = (n: number): VerifiedCaller => ({ ...caller, sub: `idp|${n}` });
      for (let n = 0; n <= 10_000; n++) await resolveAccountsUserId(user(n), deps);
      expect(deps.memory.ids.size).toBe(10_000);
      expect(deps.memory.ids.has("idp|0")).toBe(false);
      expect(deps.memory.ids.has("idp|1")).toBe(true);
      expect(deps.memory.ids.has("idp|10000")).toBe(true);
    });

    test("a 401 is not cached, so the next request asks again", async () => {
      const deps = setup(async () => { throw new UnknownAccountError(); });
      await expect(resolveAccountsUserId(caller, deps)).rejects.toBeInstanceOf(UnknownAccountError);
      await expect(resolveAccountsUserId(caller, deps)).rejects.toBeInstanceOf(UnknownAccountError);
      expect(deps.client.me).toHaveBeenCalledTimes(2);
      expect(deps.memory.ids.size).toBe(0);
      expect(deps.memory.inflight.size).toBe(0);
      expect(deps.kv.size).toBe(0);
    });

    test("an unreadable KV value counts as a miss", async () => {
      const deps = setup();
      await deps.kv.put(kvKey(caller.sub), "not json");
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(deps.client.me).toHaveBeenCalledOnce();
    });

    test("a failing KV read counts as a miss", async () => {
      const deps = setup();
      vi.spyOn(deps.kv, "get").mockRejectedValue(new Error("kv down"));
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(deps.client.me).toHaveBeenCalledOnce();
    });

    test("a failing KV write is logged, and memory still answers the next request", async () => {
      const deps = setup();
      vi.spyOn(deps.kv, "put").mockRejectedValue(new Error("kv down"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(warn).toHaveBeenCalledOnce();
      expect(await resolveAccountsUserId(caller, deps)).toBe("acc-1");
      expect(deps.client.me).toHaveBeenCalledOnce();
    });

    test("concurrent cold lookups for one sub share one accounts call", async () => {
      const deps = setup();
      const ids = await Promise.all(Array.from({ length: 5 }, () => resolveAccountsUserId(caller, deps)));
      expect(ids).toEqual(Array(5).fill("acc-1"));
      expect(deps.client.me).toHaveBeenCalledOnce();
      expect(deps.memory.inflight.size).toBe(0);
    });

    test("a joiner whose shared lookup never settles fails closed after the accounts timeout", async () => {
      const deps = setup(() => new Promise<string>(() => {}));
      void resolveAccountsUserId(caller, deps);
      const joiner = resolveAccountsUserId(caller, deps).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2999);
      expect(deps.memory.inflight.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await joiner).toBeInstanceOf(TenancyUnavailableError);
      expect(deps.memory.inflight.size).toBe(0);
    });

    test("a stale lookup settling late leaves the newer lookup shared", async () => {
      let settleStale = (_: string) => {};
      const deps = setup(() => new Promise<string>((resolve) => { settleStale = resolve; }));
      const stale = resolveAccountsUserId(caller, deps);
      const joiner = resolveAccountsUserId(caller, deps).catch(() => {});
      await vi.advanceTimersByTimeAsync(3000);
      await joiner;
      deps.client.me.mockImplementation(() => new Promise<string>(() => {}));
      void resolveAccountsUserId(caller, deps);
      const newer = deps.memory.inflight.get(caller.sub);
      settleStale("acc-1");
      expect(await stale).toBe("acc-1");
      expect(deps.memory.inflight.get(caller.sub)).toBe(newer);
    });

    test("forgetting a sub drops it from both tiers", async () => {
      const deps = setup();
      await resolveAccountsUserId(caller, deps);
      await forgetAccountsUserId(caller.sub, deps);
      expect(deps.memory.ids.size).toBe(0);
      expect(deps.kv.size).toBe(0);
      await resolveAccountsUserId(caller, deps);
      expect(deps.client.me).toHaveBeenCalledTimes(2);
    });
  });
}
