import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { TEST_ITERATIONS } from "../../adapters/memory/fixture";
import type { AssetProtection } from "../asset/repository";
import { hashPassword } from "./password";

vi.mock("./password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const PASSWORD = "correct horse";
const IP = "203.0.113.1";

/** A fresh module graph, so every test starts with an empty per-isolate memo. */
async function freshAttempt() {
  vi.resetModules();
  const { attemptPassword } = await import("./attempt");
  const verifyPassword = vi.mocked((await import("./password")).verifyPassword);
  verifyPassword.mockClear();
  return { attemptPassword, verifyPassword };
}

describe("attemptPassword memo", () => {
  let protection: AssetProtection;
  let kv: MemoryKeyValue;

  beforeAll(async () => {
    const { hash, salt } = await hashPassword(PASSWORD, { iterations: TEST_ITERATIONS });
    protection = { hash, salt, version: 1 };
  });

  beforeEach(() => {
    kv = new MemoryKeyValue();
  });

  test("ten correct attempts for one asset run PBKDF2 once", async () => {
    const { attemptPassword, verifyPassword } = await freshAttempt();
    for (let i = 0; i < 10; i++) {
      expect(await attemptPassword(kv, "a", protection, PASSWORD, IP, 1_000 + i)).toEqual({ kind: "ok" });
    }
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  test("a bumped password version runs PBKDF2 again", async () => {
    const { attemptPassword, verifyPassword } = await freshAttempt();
    await attemptPassword(kv, "a", protection, PASSWORD, IP, 1_000);
    await attemptPassword(kv, "a", protection, PASSWORD, IP, 1_001);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    const bumped = { ...protection, version: 2 };
    expect(await attemptPassword(kv, "a", bumped, PASSWORD, IP, 1_002)).toEqual({ kind: "ok" });
    expect(verifyPassword).toHaveBeenCalledTimes(2);
  });

  test("the isolate's memo holds 1,000 assets and evicts the least recently used at 1,001", async () => {
    const { attemptPassword, verifyPassword } = await freshAttempt();
    for (let i = 0; i < 1_000; i++) await attemptPassword(kv, `a${i}`, protection, PASSWORD, IP, 1_000);
    await attemptPassword(kv, "a0", protection, PASSWORD, IP, 1_001);
    expect(verifyPassword).toHaveBeenCalledTimes(1_000);

    await attemptPassword(kv, "a1000", protection, PASSWORD, IP, 1_002);
    await attemptPassword(kv, "a0", protection, PASSWORD, IP, 1_003);
    expect(verifyPassword).toHaveBeenCalledTimes(1_001);
    await attemptPassword(kv, "a1", protection, PASSWORD, IP, 1_004);
    expect(verifyPassword).toHaveBeenCalledTimes(1_002);
  });
});
