import { describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import {
  parseAssetPath,
  parseDeliveryTokenKeys,
  type AssetPath,
  type UnixSeconds,
  type UnsignedClaims,
} from "../../core/access/token";
import { WebCryptoDeliveryTokenCodec } from "./delivery-token";

const NOW = 1_800_000_000 as UnixSeconds;
const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const codec = (active: string, keys: Record<string, string>) =>
  new WebCryptoDeliveryTokenCodec(parseDeliveryTokenKeys(JSON.stringify({ active, keys })));

const claims: UnsignedClaims = {
  assetId: "asset-1",
  versionId: "v-1",
  prefix: parseAssetPath("tiles/") as AssetPath,
  exp: (NOW + 600) as UnixSeconds,
};

describe("WebCryptoDeliveryTokenCodec", () => {
  const k1 = codec("k1", { k1: secret(1) });

  test("verifies its own token and returns the claims stamped with the active kid", async () => {
    const token = await k1.sign(claims, NOW);
    expect(await k1.verify(token, NOW)).toEqual({ ok: true, claims: { v: 1, kid: "k1", ...claims } });
  });

  test("refuses a token with any single byte flipped", async () => {
    const token = await k1.sign(claims, NOW);
    for (let i = 0; i < token.length; i++) {
      const flipped = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
      const result = await k1.verify(flipped, NOW);
      expect(result.ok, `byte ${i}`).toBe(false);
    }
    const macStart = token.indexOf(".") + 1;
    const flippedMac = token.slice(0, macStart) + (token[macStart] === "A" ? "B" : "A") + token.slice(macStart + 1);
    expect(await k1.verify(flippedMac, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("refuses a MAC computed over the claims without the label", async () => {
    const [encoded] = (await k1.sign(claims, NOW)).split(".");
    const unlabelled = createHmac("sha256", Buffer.alloc(32, 1)).update(encoded).digest("base64url");
    expect(await k1.verify(`${encoded}.${unlabelled}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("answers unknown_kid for a key the ring does not list", async () => {
    const token = await codec("k2", { k2: secret(2) }).sign(claims, NOW);
    expect(await k1.verify(token, NOW)).toEqual({ ok: false, reason: "unknown_kid" });
  });

  test("accepts up to 30 s past exp and refuses after", async () => {
    const token = await k1.sign(claims, NOW);
    expect((await k1.verify(token, (claims.exp + 30) as UnixSeconds)).ok).toBe(true);
    expect(await k1.verify(token, (claims.exp + 31) as UnixSeconds)).toEqual({ ok: false, reason: "expired" });
  });

  test("checks the MAC before expiry, so an expired and tampered token is bad_signature", async () => {
    const token = await k1.sign(claims, NOW);
    const macStart = token.indexOf(".") + 1;
    const tampered = token.slice(0, macStart) + (token[macStart] === "A" ? "B" : "A") + token.slice(macStart + 1);
    expect(await k1.verify(tampered, (claims.exp + 31) as UnixSeconds)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("answers malformed for a MAC whose last character differs only in its unused trailing bits", async () => {
    const token = await k1.sign(claims, NOW);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[alphabet.indexOf(token.at(-1)!) ^ 1];
    const nonCanonical = token.slice(0, -1) + sibling;
    expect(Buffer.from(nonCanonical.split(".")[1], "base64url")).toEqual(Buffer.from(token.split(".")[1], "base64url"));
    expect(await k1.verify(nonCanonical, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  test.each([
    ["a fractional exp", { exp: (NOW + 0.5) as UnixSeconds }],
    ["an empty assetId", { assetId: "" }],
    ["a prefix with a dot segment", { prefix: "a/../b" as AssetPath }],
    ["a prefix with a leading slash", { prefix: "/tiles" as AssetPath }],
  ])("refuses to sign %s", async (_, override) => {
    await expect(k1.sign({ ...claims, ...override }, NOW)).rejects.toThrow("delivery token claims are invalid");
  });

  test("refuses to sign a token that lives longer than 7 days", async () => {
    const week = 7 * 24 * 60 * 60;
    await expect(k1.sign({ ...claims, exp: (NOW + week) as UnixSeconds }, NOW)).resolves.toBeTypeOf("string");
    await expect(k1.sign({ ...claims, exp: (NOW + week + 1) as UnixSeconds }, NOW)).rejects.toThrow(RangeError);
  });

  test("rotation keeps k1 tokens valid while k1 is listed, and refuses them once it is removed", async () => {
    const token = await k1.sign(claims, NOW);
    const rotated = codec("k2", { k1: secret(1), k2: secret(2) });
    const retired = codec("k2", { k2: secret(2) });

    expect((await rotated.verify(token, NOW)).ok).toBe(true);
    expect(await retired.verify(token, NOW)).toEqual({ ok: false, reason: "unknown_kid" });

    const signedAfterRotation = await rotated.sign(claims, NOW);
    expect(await retired.verify(signedAfterRotation, NOW)).toEqual({ ok: true, claims: { v: 1, kid: "k2", ...claims } });
  });

  test.each(["", ".", "abc", "a.b.c", "!!.!!", "e30.", ".AAAA"])("answers malformed for %j", async (token) => {
    expect(await k1.verify(token, NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
