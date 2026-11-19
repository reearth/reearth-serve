import type { ArchiveSource } from "../archive";
import type { AssetMetadata, AssetVersion, ContainerMeta } from "./model";

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
  /** What upload finalisation recorded; absent when it did not run. */
  container?: ContainerMeta;
}

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
    container: row.container,
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

export function archiveSource(layout: Layout): ArchiveSource | null {
  if (layout.archiveFormat !== "zip") return null;
  const index = layout.container && "index" in layout.container ? layout.container.index : undefined;
  return { key: mainKey(layout), size: layout.size, filename: layout.filename, ...(index && { index }) };
}
