import { describe, expect, test } from "vitest";
import {
  decodeClaims,
  encodeClaims,
  parseAssetPath,
  parseDeliveryTokenKeys,
  type AssetPath,
  type DeliveryClaims,
  type KeyId,
  type UnixSeconds,
} from "./token";

describe("parseAssetPath", () => {
  test.each([
    ["a/b", "a/b"],
    ["/a/b", "a/b"],
    ["a%2Fb", "a/b"],
    ["100%.png", "100%.png"],
    ["100%25.png", "100%.png"],
    ["%41", "A"],
    ["%E5%9C%B0%E5%9B%B3.png", "地図.png"],
    ["", ""],
    ["/", ""],
    ["a//b", "a//b"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(parseAssetPath(raw)).toBe(expected);
  });

  test.each([
    "a/../b",
    "a/%2e%2e/b",
    "a/%2E/b",
    "./a",
    "..",
    "a%252Fb",
    "a%252fb",
    "a\\b",
    "a%5Cb",
    "a%00b",
    "%E5%9C",
  ])("refuses %j", (raw) => {
    expect(parseAssetPath(raw)).toBeNull();
  });
});

describe("claims encoding", () => {
  const claims: DeliveryClaims = {
    v: 1,
    kid: "k1" as KeyId,
    assetId: "asset-1",
    versionId: null,
    prefix: "tiles/地図" as AssetPath,
    exp: 1_900_000_000 as UnixSeconds,
  };

  test("round-trips through base64url JSON", () => {
    const encoded = encodeClaims(claims);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeClaims(encoded)).toEqual(claims);
    expect(decodeClaims(encodeClaims({ ...claims, versionId: "v-2" }))).toEqual({ ...claims, versionId: "v-2" });
  });

  test("refuses claims a well-formed signer never produces", () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(decodeClaims(encode({ ...claims, v: 2 }))).toBeNull();
    expect(decodeClaims(encode({ ...claims, exp: 1.5 }))).toBeNull();
    expect(decodeClaims(encode({ ...claims, prefix: "a/../b" }))).toBeNull();
    expect(decodeClaims(encode({ ...claims, kid: "" }))).toBeNull();
    expect(decodeClaims(encode({ ...claims, prefix: "/tiles" }))).toBeNull();
    expect(decodeClaims(`${encodeClaims(claims)}=`)).toBeNull();
    expect(decodeClaims("not json")).toBeNull();
  });
});

describe("parseDeliveryTokenKeys", () => {
  const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64");

  test("builds a ring with the active key and the other listed key", () => {
    const ring = parseDeliveryTokenKeys(
      JSON.stringify({ active: "k2", keys: { k1: secret(1), k2: secret(2) } }),
    );
    expect(ring.active.kid).toBe("k2");
    expect(ring.active.secret).toEqual(new Uint8Array(32).fill(2));
    expect(ring.inactive?.kid).toBe("k1");
    expect(parseDeliveryTokenKeys(JSON.stringify({ active: "k1", keys: { k1: secret(1) } })).inactive).toBeNull();
  });

  test.each([
    ["{", "DELIVERY_TOKEN_KEYS: not valid JSON"],
    ['{"active":"k1","keys":{"k1":"c2hvcnQ="}}', "DELIVERY_TOKEN_KEYS: key k1 is shorter than 32 bytes"],
    [
      JSON.stringify({ active: "k1", keys: { k1: secret(1), k2: secret(2), k3: secret(3) } }),
      "DELIVERY_TOKEN_KEYS: lists 3 keys; at most 2 are allowed",
    ],
    [JSON.stringify({ active: "k9", keys: { k1: secret(1) } }), "DELIVERY_TOKEN_KEYS: active key k9 is not listed"],
    [JSON.stringify({ active: "k1", keys: {} }), "DELIVERY_TOKEN_KEYS: active key k1 is not listed"],
    [JSON.stringify({ keys: { k1: secret(1) } }), /DELIVERY_TOKEN_KEYS: expected/],
    [JSON.stringify({ active: "k1", keys: { k1: "!!" } }), "DELIVERY_TOKEN_KEYS: key k1 is not valid base64"],
  ])("refuses %s", (raw, message) => {
    expect(() => parseDeliveryTokenKeys(raw)).toThrow(message);
  });
});
