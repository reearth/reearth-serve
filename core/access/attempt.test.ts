import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { TEST_ITERATIONS } from "../../adapters/memory/fixture";
import type { AssetProtection } from "../asset/repository";
import { attemptPassword } from "./attempt";
import { hashPassword, verifyPassword } from "./password";

vi.mock("./password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const PASSWORD = "correct horse";

describe("attemptPassword memo", () => {
  let protection: AssetProtection;

  beforeAll(async () => {
    const { hash, salt } = await hashPassword(PASSWORD, { iterations: TEST_ITERATIONS });
    protection = { hash, salt, version: 1 };
  });

  beforeEach(() => {
    vi.mocked(verifyPassword).mockClear();
  });

  test("ten correct attempts for one asset run PBKDF2 once", async () => {
    const kv = new MemoryKeyValue();
    for (let i = 0; i < 10; i++) {
      expect(await attemptPassword(kv, "memo-once", protection, PASSWORD, "203.0.113.1", 1_000 + i))
        .toEqual({ kind: "ok" });
    }
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  test("a bumped password version runs PBKDF2 again", async () => {
    const kv = new MemoryKeyValue();
    await attemptPassword(kv, "memo-version", protection, PASSWORD, "203.0.113.1", 1_000);
    await attemptPassword(kv, "memo-version", protection, PASSWORD, "203.0.113.1", 1_001);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    const bumped = { ...protection, version: 2 };
    expect(await attemptPassword(kv, "memo-version", bumped, PASSWORD, "203.0.113.1", 1_002))
      .toEqual({ kind: "ok" });
    expect(verifyPassword).toHaveBeenCalledTimes(2);
  });
});
