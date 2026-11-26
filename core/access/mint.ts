/**
 * The pure half of `POST /api/v1/assets/{id}/signed-urls` (ADR-014 §4 Mint):
 * what a token may name, given the asset, the ID in the URL and the body.
 * The route does the I/O and answers the checks in the ADR's order.
 */

import type { AssetMetadata, AssetVersion } from "../asset/model";
import { accessModeOf } from "./resolve";
import { toAssetPath, type AssetPath, type UnixSeconds, type UnsignedClaims } from "./token";

/** A mint `prefix` is decoded already: one leading `/` goes, then the asset path rules apply. */
export function mintPrefix(raw: string): AssetPath | null {
  return toAssetPath(raw.startsWith("/") ? raw.slice(1) : raw);
}

export interface MintInput {
  asset: AssetMetadata;
  /** Set when the URL's ID was a version ID, which pins the token. */
  urlVersionId: string | null;
  /** The body's `versionId`, and the version row it names, if any. */
  bodyVersion: { id: string; found: AssetVersion | null } | null;
  prefix: AssetPath;
  expiresIn: number;
  now: UnixSeconds;
}

export type MintPlan = { ok: true; claims: UnsignedClaims } | { ok: false; error: string };

export function planMint(input: MintInput): MintPlan {
  const { asset, urlVersionId, bodyVersion } = input;
  // Any member could otherwise mint a 7-day link that skips the password
  // (ADR-014 alternative K).
  if (accessModeOf(asset) === "password") {
    return { ok: false, error: "delivery tokens do not open password-protected assets" };
  }
  if (bodyVersion && bodyVersion.found?.assetId !== asset.id) {
    return { ok: false, error: "versionId is not a version of this asset" };
  }
  if (bodyVersion && urlVersionId !== null && bodyVersion.id !== urlVersionId) {
    return { ok: false, error: "versionId differs from the version ID in the URL" };
  }
  return {
    ok: true,
    claims: {
      assetId: asset.id,
      versionId: urlVersionId ?? bodyVersion?.id ?? null,
      prefix: input.prefix,
      exp: (input.now + input.expiresIn) as UnixSeconds,
    },
  };
}

export function mintResponse(token: string, claims: UnsignedClaims, baseUrl: string) {
  return {
    token,
    expiresAt: claims.exp * 1000,
    urlTemplate: `${baseUrl}/files/${claims.versionId ?? claims.assetId}/{path}?serve_token=${token}`,
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const asset: AssetMetadata = {
    id: "a1", filename: "site.zip", contentType: "application/zip", size: 1, createdAt: 0, expiresAt: 0,
    access: "restricted",
  };
  const version = (id: string, assetId = "a1") => ({ id, assetId } as AssetVersion);
  const base: MintInput = {
    asset, urlVersionId: null, bodyVersion: null, prefix: "" as AssetPath, expiresIn: 3600, now: 1_000 as UnixSeconds,
  };

  test("mintPrefix strips one leading slash and refuses what a path may not hold", () => {
    expect(mintPrefix("/tiles/")).toBe("tiles/");
    expect(mintPrefix("")).toBe("");
    expect(mintPrefix("a//b")).toBe("a//b");
    for (const bad of ["//a", "tiles/../x", "..", "./a", "a\\b", "a\u0000b", "a%2Fb"]) expect(mintPrefix(bad), bad).toBeNull();
  });

  test("an unpinned token follows the asset", () => {
    expect(planMint(base)).toEqual({ ok: true, claims: { assetId: "a1", versionId: null, prefix: "", exp: 4_600 } });
  });

  test("a version ID in the URL or the body pins the token, and the two must agree", () => {
    expect(planMint({ ...base, urlVersionId: "v1" })).toMatchObject({ ok: true, claims: { versionId: "v1" } });
    expect(planMint({ ...base, bodyVersion: { id: "v1", found: version("v1") } }))
      .toMatchObject({ ok: true, claims: { versionId: "v1" } });
    expect(planMint({ ...base, urlVersionId: "v1", bodyVersion: { id: "v1", found: version("v1") } }))
      .toMatchObject({ ok: true, claims: { versionId: "v1" } });
    expect(planMint({ ...base, urlVersionId: "v1", bodyVersion: { id: "v2", found: version("v2") } }).ok).toBe(false);
  });

  test("a body versionId of another asset, or of none, is refused", () => {
    expect(planMint({ ...base, bodyVersion: { id: "v9", found: null } }).ok).toBe(false);
    expect(planMint({ ...base, bodyVersion: { id: "v9", found: version("v9", "a2") } }).ok).toBe(false);
  });

  test("a password asset is refused; public and restricted mint", () => {
    expect(planMint({ ...base, asset: { ...asset, access: "password" } }).ok).toBe(false);
    expect(planMint({ ...base, asset: { ...asset, access: "public" } }).ok).toBe(true);
    expect(planMint({ ...base, asset: { ...asset, access: undefined } }).ok).toBe(true);
  });

  test("the response names the pinned version in the template and expiresAt in milliseconds", () => {
    const claims = { assetId: "a1", versionId: "v1", prefix: "" as AssetPath, exp: 4_600 as UnixSeconds };
    expect(mintResponse("t.k", claims, "https://serve.example.com")).toEqual({
      token: "t.k",
      expiresAt: 4_600_000,
      urlTemplate: "https://serve.example.com/files/v1/{path}?serve_token=t.k",
    });
  });
}
