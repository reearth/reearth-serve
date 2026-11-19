import {
  buildContainerIndex,
  createArchiveCache,
  type ArchiveCache,
  type ArchiveSource,
  type ContainerLimits,
  type ContainerOutcome,
} from "../../archive";
import { readSiteHostingInPlace } from "../../site/hosting";
import type { ArchiveFormat, ContainerMeta, SiteHosting } from "../../../shared/api";
import type { FileStorage } from "../repository";

export interface FinaliseArchiveDeps {
  storage: FileStorage;
  archives?: ArchiveCache;
  limits?: ContainerLimits;
}

export interface FinaliseArchiveInput {
  /** The layout root the original was written under: `assets/{id}` or `assets/{id}/v/{vid}`. */
  root: string;
  filename: string;
  size: number;
  archiveFormat: ArchiveFormat | null;
}

/** Fields merged into the row input, so the row is written once, after every object it names. */
export interface ArchiveFinalisation {
  container?: ContainerMeta;
  hosting?: SiteHosting;
}

/** The one writer of the index key. Readers take it from `container.index` and never call this. */
export function containerIndexKey(root: string): string {
  return `${root}/_archive/container.v1`;
}

/** Objects finalisation wrote, for a caller that compensates a failed row write. */
export function writtenKeys(finalised: ArchiveFinalisation): string[] {
  return finalised.container && "index" in finalised.container ? [finalised.container.index] : [];
}

const QUIET_REFUSALS = new Set(["missing", "not-zip", "encoded-original"]);

/**
 * Run between the original's put and the row write. Never throws: the original
 * is already stored, and the upload must succeed without an index or rules.
 * A rerun over the same original writes the same index bytes and returns the
 * same fields.
 */
export async function finaliseArchive(deps: FinaliseArchiveDeps, input: FinaliseArchiveInput): Promise<ArchiveFinalisation> {
  if (input.archiveFormat !== "zip") return {};
  const archives = deps.archives ?? createArchiveCache();
  const source: ArchiveSource = { key: `${input.root}/${input.filename}`, size: input.size, filename: input.filename };

  const container = await recordContainer(deps, source, containerIndexKey(input.root));
  const indexed = container && "index" in container ? { ...source, index: container.index } : source;
  const hosting = await readHosting(deps.storage, archives, indexed);

  return { ...(container && { container }), ...(hosting && { hosting }) };
}

async function recordContainer(deps: FinaliseArchiveDeps, source: ArchiveSource, target: string): Promise<ContainerMeta | undefined> {
  let outcome: ContainerOutcome;
  try {
    outcome = await buildContainerIndex(deps.storage, source, target, deps.limits);
  } catch (e) {
    console.error(`Container index build failed for ${source.key}:`, e);
    return undefined;
  }
  if (!outcome.ok) {
    if (!QUIET_REFUSALS.has(outcome.reason)) console.error(`Container index refused for ${source.key}: ${outcome.reason}`);
    return undefined;
  }
  const { directory, rootPrefix } = outcome;
  return "index" in outcome
    ? { index: outcome.index, directory, rootPrefix }
    : { skipped: outcome.skipped, directory, rootPrefix };
}

async function readHosting(storage: FileStorage, archives: ArchiveCache, source: ArchiveSource): Promise<SiteHosting | null> {
  try {
    return await readSiteHostingInPlace({ storage, archives }, source);
  } catch (e) {
    console.error(`Site hosting parse failed for ${source.key}:`, e);
    return null;
  }
}
