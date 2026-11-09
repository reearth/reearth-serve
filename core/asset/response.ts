/**
 * Asset and version rows as the API shows them.
 *
 * The rows carry ledger fields that are not part of the API (`blobKey`,
 * ADR-017 §3). Every route that sends an asset or a version passes it through
 * here, so where the bytes live stays an implementation detail — P3 may move
 * them again without a client noticing.
 */
import type { AssetMetadata as ApiAssetMetadata, AssetVersion as ApiAssetVersion } from "../../shared/api";
import type { AssetMetadata, AssetVersion } from "./model";

export function toVersionResponse(version: AssetVersion): ApiAssetVersion {
  const { blobKey: _blobKey, ...rest } = version;
  return rest;
}

export function toAssetResponse(asset: AssetMetadata): ApiAssetMetadata {
  const { blobKey: _blobKey, currentVersion, ...rest } = asset;
  return { ...rest, ...(currentVersion && { currentVersion: toVersionResponse(currentVersion) }) };
}

/** An upload result (`{ asset, url, siteUrl? }`) with its asset projected. */
export function toUploadResponse<T extends { asset: AssetMetadata }>(result: T): Omit<T, "asset"> & { asset: ApiAssetMetadata } {
  return { ...result, asset: toAssetResponse(result.asset) };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("responses drop blobKey from the asset and its current version", () => {
    const version: AssetVersion = {
      id: "v1", assetId: "a1", version: 2, filename: "f", contentType: "t", size: 1, createdAt: 1, blobKey: "blobs/w1/x",
    };
    const asset: AssetMetadata = {
      id: "a1", filename: "f", contentType: "t", size: 1, createdAt: 1, expiresAt: 0, blobKey: "blobs/w1/y",
      currentVersion: version,
    };
    const shown = toAssetResponse(asset);
    expect(shown).not.toHaveProperty("blobKey");
    expect(shown.currentVersion).not.toHaveProperty("blobKey");
    expect(shown.currentVersion?.id).toBe("v1");
    expect(toVersionResponse(version)).not.toHaveProperty("blobKey");
    expect(toUploadResponse({ asset, url: "u" })).toEqual({ asset: shown, url: "u" });
  });
}
