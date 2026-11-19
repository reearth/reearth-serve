import type { ArchiveSource } from "../archive";
import type { AssetMetadata, AssetVersion } from "./model";

/**
 * One storage layout an asset's bytes may live under. Versioned assets use
 * `assets/{asset}/v/{version}/…`; assets that predate ADR-005 use
 * `assets/{asset}/…`. They differ only in prefix and in which row describes
 * the uploaded object, so delivery and listing work against this shape and
 * never against the raw asset and version rows.
 */
export interface Layout {
  root: string;
  filename: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
  originalSize?: number;
  archive: boolean;
  archiveFormat?: string;
}

/**
 * The versioned layout first, the legacy one second. The Cloudflare launcher
 * still extracts a version's files under the legacy prefix, so a lookup that
 * only knew the versioned one would miss them.
 */
export function assetLayouts(asset: AssetMetadata, version: AssetVersion | null): Layout[] {
  const legacy = layoutOf(`assets/${asset.id}`, asset);
  return version ? [layoutOf(`assets/${asset.id}/v/${version.id}`, version), legacy] : [legacy];
}

function layoutOf(root: string, row: AssetMetadata | AssetVersion): Layout {
  return {
    root,
    filename: row.filename,
    size: row.size,
    contentType: row.contentType,
    contentEncoding: row.contentEncoding,
    originalSize: row.originalSize,
    archive: row.type === "archive",
    archiveFormat: row.archiveFormat,
  };
}

export function mainKey(layout: Layout): string {
  return `${layout.root}/${layout.filename}`;
}

export function entryKey(layout: Layout, path: string): string {
  return `${layout.root}/files/${path}`;
}

export function manifestKey(layout: Layout): string {
  return `${layout.root}/_archive/_manifest.jsonl`;
}

/** The original as an in-place source, for the formats that can be read in place. */
export function archiveSource(layout: Layout): ArchiveSource | null {
  if (layout.archiveFormat !== "zip") return null;
  return { key: mainKey(layout), size: layout.size, filename: layout.filename };
}
