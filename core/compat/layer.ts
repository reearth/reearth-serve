import type { Deps } from "../types";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { Project } from "../project/model";
import { authorizeService } from "../auth/access";
import type { ProjectAction } from "../auth/permissions";
import type { ServicePrincipal } from "../auth/types";
import { uploadAsset } from "../asset/usecase/upload";
import { uploadVersion, type UploadVersionResult } from "../asset/usecase/upload-version";
import { deleteAsset } from "../asset/usecase/delete";
import { resolveAssetVersion } from "../asset/usecase/resolve-version";
import { updateAsset } from "../asset/usecase/update-asset";
import { siteHostDepsFrom } from "../site/handler";
import { hashingStream, type HashingStream } from "./hash";
import { listPage, type ListQuery } from "./list";
import { newLeaseToken, type ClaimToken, type LeaseToken, type VersionRecord } from "./repository";
import {
  parseBucketName,
  type Binding, type CompatBucket, type CompatError, type ExactHashes, type ObjectInfo, type ObjectKey,
  type PutMeta, type Result, type SizedBody,
} from "./model";

export type ObjectLayerDeps = Pick<
  Deps,
  | "compat" | "projects" | "serviceAuthorizer" | "metadata" | "versions" | "writes" | "storage" | "ttlSeconds"
  | "baseUrl" | "extractionQueue" | "thumbnailQueue" | "pendingCleanup" | "siteHosts" | "cache" | "siteHostSuffix"
  | "dns" | "customHostnames" | "siteFallbackOrigin"
>;

export type ListPage = { objects: ObjectInfo[]; prefixes: string[]; nextPageToken: string | null };

export type ReplayableCommit = { assetId: string; versionId: string; token: ClaimToken & LeaseToken };

export interface ObjectLayer {
  head(bucket: string, key: ObjectKey): Promise<Result<ObjectInfo>>;
  list(bucket: string, query: ListQuery): Promise<Result<ListPage>>;
  put(bucket: string, key: ObjectKey, meta: PutMeta, body: SizedBody, commit?: ReplayableCommit): Promise<Result<ObjectInfo>>;
  delete(bucket: string, key: ObjectKey): Promise<Result<void>>;
}

export const HOLD_STALE_MS = 10 * 60 * 1000;

/**
 * Each listed object costs a few point reads, and a Worker invocation may run
 * at most 1,000 D1 queries, so a page stops short of GCS's 1,000 items. The
 * client follows `nextPageToken` either way.
 */
export const LIST_PAGE_CAP = 200;

type Resolved = { binding: Extract<Binding, { kind: "object" }>; asset: AssetMetadata; version: AssetVersion | null };

const fail = (error: CompatError): { ok: false; error: CompatError } => ({ ok: false, error });

const LENGTH_MISMATCH: CompatError = { code: "invalid", message: "The request body does not match its Content-Length." };

export async function authorizeBucket(
  deps: Pick<ObjectLayerDeps, "compat" | "serviceAuthorizer" | "projects">, service: ServicePrincipal, raw: string, action: ProjectAction,
): Promise<Result<{ bucket: CompatBucket; project: Project }>> {
  const name = parseBucketName(raw);
  const bucket = name ? await deps.compat.findBucket(name) : null;
  if (!bucket) return fail({ code: "no_such_bucket" });
  const decision = await authorizeService(
    { authorizer: deps.serviceAuthorizer, projects: deps.projects },
    service,
    { projectId: bucket.projectId, bucket: bucket.name },
    action,
  );
  if (!decision.ok) return fail({ code: decision.reason === "forbidden" ? "forbidden" : "no_such_bucket" });
  return { ok: true, value: { bucket, project: decision.value } };
}

export function objectLayer(deps: ObjectLayerDeps, service: ServicePrincipal, now: () => number = Date.now): ObjectLayer {
  const { compat } = deps;
  const authorized = (raw: string, action: ProjectAction) => authorizeBucket(deps, service, raw, action);

  async function resolve(bucket: CompatBucket, key: ObjectKey): Promise<Resolved | null> {
    const binding = await compat.findBinding(bucket.name, key);
    return binding?.kind === "object" ? load(bucket, binding) : null;
  }

  async function load(bucket: CompatBucket, binding: Extract<Binding, { kind: "object" }>): Promise<Resolved | null> {
    const found = await resolveAssetVersion(deps.metadata, deps.versions, binding.assetId);
    if (!found || found.asset.id !== binding.assetId || found.asset.projectId !== bucket.projectId) return null;
    return { binding, ...found };
  }

  async function describe(bucket: CompatBucket, r: Resolved): Promise<ObjectInfo> {
    const record = await compat.findRecord(r.version?.id ?? r.asset.id);
    return infoOf(bucket, r.binding.key, r.asset, r.version, record);
  }

  async function recordVersion(bucket: CompatBucket, objectRef: string, assetId: string, createdAt: number, hashes: ExactHashes): Promise<VersionRecord> {
    const generation = await compat.nextGeneration(bucket.name, generationFromCreatedAt(createdAt));
    const stored = { generation, hashes };
    await compat.putRecord(objectRef, assetId, stored);
    return stored;
  }

  async function writeVersion(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, asset: AssetMetadata, versionId?: string,
  ): Promise<Result<ObjectInfo>> {
    const checked = lengthCheckedBody(body);
    let result: UploadVersionResult | null;
    try {
      result = await uploadVersion(deps.metadata, deps.writes, deps.storage, asset.id, fileOf(key, meta, body, checked.stream), deps.baseUrl, {
        extractionQueue: deps.extractionQueue,
        thumbnailQueue: deps.thumbnailQueue,
        usageScopes: scopes,
        siteHostSuffix: deps.siteHostSuffix,
        userMeta: meta.userMeta,
        ...(versionId && { versionId }),
      });
    } catch (e) {
      if (checked.lengthMismatched()) return fail(LENGTH_MISMATCH);
      throw e;
    }
    if (!result) return fail({ code: "busy" });
    return activate(bucket, key, asset, result.version, await checked.digest());
  }

  async function activate(
    bucket: CompatBucket, key: ObjectKey, asset: AssetMetadata, version: AssetVersion, hashes: ExactHashes,
  ): Promise<Result<ObjectInfo>> {
    if (asset.activeVersionId) await updateAsset(deps.metadata, deps.versions, asset.id, { activeVersionId: null });
    const stored = (await compat.findRecord(version.id))
      ?? await recordVersion(bucket, version.id, asset.id, version.createdAt, hashes);
    return { ok: true, value: infoOf(bucket, key, asset, version, stored) };
  }

  async function writeAsset(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, token: ClaimToken, commit?: ReplayableCommit,
  ): Promise<Result<ObjectInfo>> {
    const written = commit ? await deps.metadata.find(commit.assetId) : null;
    if (written && body.hashes) {
      await body.stream.cancel();
      return bindAsset(bucket, key, scopes, token, written, body.hashes);
    }
    const checked = lengthCheckedBody(body);
    let asset: AssetMetadata;
    try {
      ({ asset } = await uploadAsset(deps.writes, deps.storage, fileOf(key, meta, body, checked.stream), deps.ttlSeconds, deps.baseUrl, {
        projectId: bucket.projectId,
        extractionQueue: deps.extractionQueue,
        thumbnailQueue: deps.thumbnailQueue,
        usageScopes: scopes,
        siteHostSuffix: deps.siteHostSuffix,
        userMeta: meta.userMeta,
        ...(commit && { id: commit.assetId }),
      }));
    } catch (e) {
      await compat.releaseClaim(bucket.name, key, token);
      if (checked.lengthMismatched()) return fail(LENGTH_MISMATCH);
      throw e;
    }
    return bindAsset(bucket, key, scopes, token, asset, await checked.digest());
  }

  async function bindAsset(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], token: ClaimToken, asset: AssetMetadata, hashes: ExactHashes,
  ): Promise<Result<ObjectInfo>> {
    const stored = (await compat.findRecord(asset.id)) ?? await recordVersion(bucket, asset.id, asset.id, asset.createdAt, hashes);
    if (!(await compat.bind(bucket.name, key, token, asset.id))) {
      await removeAsset(asset, scopes);
      return fail({ code: "busy" });
    }
    return { ok: true, value: infoOf(bucket, key, asset, null, stored) };
  }

  async function overwrite(
    raw: string, bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, commit?: ReplayableCommit,
  ): Promise<Result<ObjectInfo>> {
    const update = await authorized(raw, "update_asset");
    if (!update.ok) return update;
    return leased(bucket, key, async () => {
      const live = await resolve(bucket, key);
      if (!live) return fail({ code: "busy" });
      const written = commit ? await deps.versions.find(commit.versionId) : null;
      if (written?.assetId === live.asset.id && body.hashes) {
        await body.stream.cancel();
        return activate(bucket, key, live.asset, written, body.hashes);
      }
      if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== (await describe(bucket, live)).generation) {
        return fail({ code: "precondition_failed" });
      }
      return writeVersion(bucket, key, scopes, meta, body, live.asset, commit?.versionId);
    }, commit?.token);
  }

  async function leased<T>(
    bucket: CompatBucket, key: ObjectKey, work: () => Promise<Result<T>>, token: LeaseToken = newLeaseToken(),
  ): Promise<Result<T>> {
    const at = now();
    if (!(await compat.lease(bucket.name, key, token, at, at - HOLD_STALE_MS))) return fail({ code: "busy" });
    try {
      return await work();
    } finally {
      await compat.releaseLease(bucket.name, key, token);
    }
  }

  async function removeAsset(asset: AssetMetadata, scopes: string[]): Promise<void> {
    await deleteAsset(deps.writes, deps.storage, asset, {
      usageScopes: scopes,
      pendingCleanup: deps.pendingCleanup,
      siteHosts: siteHostDepsFrom(deps),
    });
  }

  return {
    async head(raw, key) {
      const auth = await authorized(raw, "read_asset");
      if (!auth.ok) return auth;
      const r = await resolve(auth.value.bucket, key);
      return r ? { ok: true, value: await describe(auth.value.bucket, r) } : fail({ code: "no_such_key" });
    },

    async list(raw, query) {
      const auth = await authorized(raw, "read_asset");
      if (!auth.ok) return auth;
      const { bucket } = auth.value;
      const page = await listPage(
        { ...query, maxResults: Math.min(query.maxResults, LIST_PAGE_CAP) },
        (from, until, limit) => compat.scanBindings(bucket.name, from, until, limit),
      );
      if (!page) return fail({ code: "invalid", message: "Invalid pageToken." });
      const infos = await Promise.all(page.objects.map(async (binding) => {
        if (binding.kind !== "object") return null;
        const r = await load(bucket, binding);
        return r ? describe(bucket, r) : null;
      }));
      return {
        ok: true,
        value: { objects: infos.filter((i): i is ObjectInfo => i !== null), prefixes: page.prefixes, nextPageToken: page.nextPageToken },
      };
    },

    async put(raw, key, meta, body, commit) {
      const auth = await authorized(raw, "create_asset");
      if (!auth.ok) return auth;
      const { bucket, project } = auth.value;
      const scopes = scopesOf(project);
      for (let attempt = 0; attempt < 2; attempt++) {
        const live = await resolve(bucket, key);
        if (live && live.asset.id === commit?.assetId && body.hashes) {
          await body.stream.cancel();
          return { ok: true, value: await describe(bucket, live) };
        }
        if (live) return overwrite(raw, bucket, key, scopes, meta, body, commit);
        if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== 0) return fail({ code: "precondition_failed" });
        const at = now();
        const claim = await compat.claim(bucket.name, key, "object", at, at - HOLD_STALE_MS, commit?.token);
        if (claim.kind === "busy") return fail({ code: "busy" });
        if (claim.kind === "claimed") return writeAsset(bucket, key, scopes, meta, body, claim.token, commit);
        if (claim.binding.kind === "object" && !(await load(bucket, claim.binding))) {
          await compat.deleteBinding(bucket.name, key);
        }
      }
      return fail({ code: "busy" });
    },

    async delete(raw, key) {
      const auth = await authorized(raw, "delete_asset");
      if (!auth.ok) return auth;
      const { bucket, project } = auth.value;
      if ((await compat.findBinding(bucket.name, key))?.kind !== "object") return { ok: true, value: undefined };
      return leased(bucket, key, async () => {
        const binding = await compat.findBinding(bucket.name, key);
        if (binding?.kind !== "object") return { ok: true, value: undefined };
        const asset = await deps.metadata.find(binding.assetId);
        if (!asset || asset.projectId !== bucket.projectId) {
          await compat.deleteBinding(bucket.name, key);
          return { ok: true, value: undefined };
        }
        await removeAsset(asset, scopesOf(project));
        return { ok: true, value: undefined };
      });
    },
  };
}

const MICROS_PER_MS = 1000;

type LengthChecked = { stream: ReadableStream<Uint8Array>; lengthMismatched(): boolean };

export function lengthChecked(stream: ReadableStream<Uint8Array>, size: number): LengthChecked {
  let seen = 0;
  let mismatch = false;
  const mismatchError = () => {
    mismatch = true;
    return new Error(`body length differs from the declared ${size} bytes`);
  };
  const counted = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > size) throw mismatchError();
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== size) throw mismatchError();
    },
  }));
  return { stream: counted, lengthMismatched: () => mismatch };
}

type LengthCheckedBody = Pick<HashingStream, "stream" | "digest"> & { lengthMismatched(): boolean };

function lengthCheckedBody(body: SizedBody): LengthCheckedBody {
  const counted = lengthChecked(body.stream, body.size);
  const known = body.hashes;
  const hashed = known ? { stream: counted.stream, digest: async () => known } : hashingStream(counted.stream);
  return { ...hashed, lengthMismatched: counted.lengthMismatched };
}

function scopesOf(project: Project): string[] {
  return project.workspaceId ? [`project:${project.id}`, `workspace:${project.workspaceId}`] : [`project:${project.id}`];
}

function filenameOf(key: ObjectKey): string {
  return key.split("/").filter(Boolean).pop() ?? "object";
}

function fileOf(key: ObjectKey, meta: PutMeta, body: SizedBody, stream: ReadableStream<Uint8Array>) {
  return {
    name: filenameOf(key),
    type: meta.contentType,
    body: stream,
    size: body.size,
    ...(meta.contentEncoding && { contentEncoding: meta.contentEncoding }),
  };
}

function stringMeta(meta: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

function generationFromCreatedAt(createdAt: number): number {
  return createdAt * MICROS_PER_MS;
}

function infoOf(
  bucket: CompatBucket, key: ObjectKey, asset: AssetMetadata, version: AssetVersion | null, record: VersionRecord | null,
): ObjectInfo {
  const current = version ?? asset;
  return {
    bucket: bucket.name,
    key,
    size: current.size,
    contentType: current.contentType,
    contentEncoding: current.contentEncoding ?? null,
    generation: record?.generation ?? generationFromCreatedAt(current.createdAt),
    metageneration: 1,
    etag: version?.id ?? asset.id,
    created: new Date(current.createdAt),
    updated: new Date(current.createdAt),
    hashes: record?.hashes ?? null,
    userMeta: stringMeta(current.userMeta),
  };
}
