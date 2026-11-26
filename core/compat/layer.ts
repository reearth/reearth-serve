import type { Deps } from "../types";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import { HoldLost, type Publishing } from "../asset/repository";
import type { Project } from "../project/model";
import { authorizeService } from "../auth/access";
import type { ProjectAction } from "../auth/permissions";
import type { ServicePrincipal } from "../auth/types";
import { uploadAsset } from "../asset/usecase/upload";
import { uploadVersion, type UploadVersionResult } from "../asset/usecase/upload-version";
import { deleteAsset } from "../asset/usecase/delete";
import { resolveAssetVersion, type ResolvedAsset } from "../asset/usecase/resolve-version";
import { updateAsset } from "../asset/usecase/update-asset";
import { siteHostDepsFrom } from "../site/handler";
import { hashingStream, type HashingStream } from "./hash";
import { listPage, type ListQuery } from "./list";
import { generateId } from "../asset/usecase/shared";
import { newLeaseToken, type ClaimToken, type CompatPublish, type LeaseToken, type RecordRef, type VersionRecord } from "./repository";
import {
  parseBucketName,
  type Binding, type CommitIds, type CompatBucket, type CompatError, type ExactHashes, type ObjectInfo, type ObjectKey,
  type PutMeta, type Result, type SizedBody,
} from "./model";

export type ObjectLayerDeps = Pick<
  Deps,
  | "compat" | "projects" | "serviceAuthorizer" | "metadata" | "versions" | "writes" | "storage" | "ttlSeconds"
  | "baseUrl" | "extractionQueue" | "thumbnailQueue" | "pendingCleanup" | "siteHosts" | "cache" | "siteHostSuffix"
  | "dns" | "customHostnames" | "siteFallbackOrigin"
>;

export type ListPage = { objects: ObjectInfo[]; prefixes: string[]; nextPageToken: string | null };

export type UploadCommit = CommitIds & {
  hashes: ExactHashes;
  overwritingAssetId: string | null;
  ownedSince: number;
  overwrite(assetId: string): Promise<boolean>;
  heartbeat(): Promise<boolean>;
  hold(): CompatPublish["upload"];
  leftovers(): string[];
};

declare const openedByTheLayer: unique symbol;

export type OpenObject = { readonly resolved: ResolvedAsset; readonly info: ObjectInfo; readonly [openedByTheLayer]: true };

export interface ObjectLayer {
  head(bucket: string, key: ObjectKey): Promise<Result<ObjectInfo>>;
  open(bucket: string, key: ObjectKey): Promise<Result<OpenObject>>;
  list(bucket: string, query: ListQuery): Promise<Result<ListPage>>;
  put(bucket: string, key: ObjectKey, meta: PutMeta, body: SizedBody, commit?: UploadCommit): Promise<Result<ObjectInfo>>;
  delete(bucket: string, key: ObjectKey): Promise<Result<void>>;
}

export const HOLD_STALE_MS = 10 * 60 * 1000;

const HEARTBEAT_MS = HOLD_STALE_MS / 4;

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

type BindingDeps = Pick<ObjectLayerDeps, "compat" | "metadata" | "versions">;

async function loadBound(deps: BindingDeps, bucket: CompatBucket, binding: Extract<Binding, { kind: "object" }>): Promise<Resolved | null> {
  const found = await resolveAssetVersion(deps.metadata, deps.versions, binding.assetId);
  if (!found || found.asset.id !== binding.assetId || found.asset.projectId !== bucket.projectId) return null;
  return { binding, ...found };
}

async function resolveBound(deps: BindingDeps, bucket: CompatBucket, key: ObjectKey): Promise<Resolved | null> {
  const binding = await deps.compat.findBinding(bucket.name, key);
  return binding?.kind === "object" ? loadBound(deps, bucket, binding) : null;
}

export interface ObjectReader {
  /** The id of the asset an exact key is bound to. No authorization: the visitor's access checks run in delivery. */
  locate(bucket: string, key: ObjectKey): Promise<string | null>;
}

export function objectReader(deps: BindingDeps): ObjectReader {
  return {
    async locate(raw, key) {
      const name = parseBucketName(raw);
      const bucket = name ? await deps.compat.findBucket(name) : null;
      const r = bucket && await resolveBound(deps, bucket, key);
      return r?.asset.id ?? null;
    },
  };
}

export function objectLayer(deps: ObjectLayerDeps, service: ServicePrincipal, now: () => number = Date.now): ObjectLayer {
  const { compat } = deps;
  const authorized = (raw: string, action: ProjectAction) => authorizeBucket(deps, service, raw, action);
  const resolve = (bucket: CompatBucket, key: ObjectKey) => resolveBound(deps, bucket, key);
  const load = (bucket: CompatBucket, binding: Extract<Binding, { kind: "object" }>) => loadBound(deps, bucket, binding);

  async function describeAll(bucket: CompatBucket, objects: Resolved[]): Promise<ObjectInfo[]> {
    const records = await compat.records(bucket.name, objects.map((r) => ({ objectRef: refOf(r), assetId: r.asset.id })));
    return objects.flatMap((r) => {
      const record = records.get(refOf(r));
      return record ? [infoOf(bucket, r.binding.key, r.asset, r.version, record)] : [];
    });
  }

  async function describe(bucket: CompatBucket, r: Resolved): Promise<ObjectInfo | null> {
    return (await describeAll(bucket, [r]))[0] ?? null;
  }

  async function recordWrite(bucket: CompatBucket, ref: Omit<RecordRef, "hashes">, hashes: ExactHashes): Promise<VersionRecord> {
    const record = (await compat.records(bucket.name, [{ ...ref, hashes }])).get(ref.objectRef);
    if (!record) throw new Error(`bucket ${bucket.name} is gone`);
    return record;
  }

  async function writeVersion(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, asset: AssetMetadata,
    held?: { versionId: string; publish: Publishing<AssetVersion>; lost(): boolean },
  ): Promise<Result<ObjectInfo>> {
    const checked = lengthCheckedBody(body);
    const versionId = held?.versionId ?? generateId();
    let result: UploadVersionResult | null;
    try {
      result = await uploadVersion(deps.metadata, deps.writes, deps.storage, asset.id, fileOf(key, meta, body, checked.stream), deps.baseUrl, {
        extractionQueue: deps.extractionQueue,
        thumbnailQueue: deps.thumbnailQueue,
        usageScopes: scopes,
        siteHostSuffix: deps.siteHostSuffix,
        userMeta: meta.userMeta,
        versionId,
        ...(held
          ? { publish: held.publish }
          : { written: { applied: async () => (await deps.versions.find(versionId)) !== null } }),
      });
    } catch (e) {
      if (e instanceof HoldLost || held?.lost()) return fail({ code: "busy" });
      if (checked.lengthMismatched()) return fail(LENGTH_MISMATCH);
      throw e;
    }
    if (!result) return fail({ code: "busy" });
    const hashes = await checked.digest();
    if (result.generation !== undefined) return { ok: true, value: infoOf(bucket, key, asset, result.version, { generation: result.generation, hashes }) };
    return activate(bucket, key, asset, result.version, hashes);
  }

  async function activate(
    bucket: CompatBucket, key: ObjectKey, asset: AssetMetadata, version: AssetVersion, hashes: ExactHashes,
  ): Promise<Result<ObjectInfo>> {
    if (asset.activeVersionId) await updateAsset(deps.metadata, deps.versions, asset.id, { activeVersionId: null });
    const stored = await recordWrite(bucket, { objectRef: version.id, assetId: asset.id }, hashes);
    return { ok: true, value: infoOf(bucket, key, asset, version, stored) };
  }

  async function writeAsset(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, token: ClaimToken, commit?: UploadCommit,
  ): Promise<Result<ObjectInfo>> {
    const beat = commit
      ? beating(body.stream, commit.ownedSince, async () => (await compat.renewClaim(bucket.name, key, token, now())) && commit.heartbeat())
      : null;
    if (beat) body = { ...body, stream: beat.stream };
    const checked = lengthCheckedBody(body);
    const id = commit?.assetId ?? generateId();
    const applied = async () => (await deps.metadata.find(id)) !== null;
    try {
      const { asset, generation } = await uploadAsset(deps.writes, deps.storage, fileOf(key, meta, body, checked.stream), deps.ttlSeconds, deps.baseUrl, {
        projectId: bucket.projectId,
        extractionQueue: deps.extractionQueue,
        thumbnailQueue: deps.thumbnailQueue,
        usageScopes: scopes,
        siteHostSuffix: deps.siteHostSuffix,
        userMeta: meta.userMeta,
        id,
        ...(commit
          ? {
            publish: {
              of: (asset) => publishing(bucket, key, commit, { kind: "claim", token, assetId: asset.id }, asset, null),
              applied,
            },
          }
          : { written: { applied } }),
      });
      const hashes = await checked.digest();
      if (generation !== undefined) return { ok: true, value: infoOf(bucket, key, asset, null, { generation, hashes }) };
      return await bindAsset(bucket, key, scopes, token, asset, hashes);
    } catch (e) {
      await compat.releaseClaim(bucket.name, key, token);
      if (e instanceof HoldLost || beat?.lost()) return fail({ code: "busy" });
      if (checked.lengthMismatched()) return fail(LENGTH_MISMATCH);
      throw e;
    }
  }

  async function bindAsset(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], token: ClaimToken, asset: AssetMetadata, hashes: ExactHashes,
  ): Promise<Result<ObjectInfo>> {
    const stored = await recordWrite(bucket, { objectRef: asset.id, assetId: asset.id }, hashes);
    const info = infoOf(bucket, key, asset, null, stored);
    if (await compat.bind(bucket.name, key, token, asset.id)) return { ok: true, value: info };
    await removeAsset(asset, scopes);
    return fail({ code: "busy" });
  }

  async function overwrite(
    raw: string, bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, commit?: UploadCommit,
  ): Promise<Result<ObjectInfo>> {
    const update = await authorized(raw, "update_asset");
    if (!update.ok) return update;
    return leased(bucket, key, async (lease) => {
      const live = await resolve(bucket, key);
      if (!live) return fail({ code: "busy" });
      if (!commit) return preconditioned(bucket, meta, live, () => writeVersion(bucket, key, scopes, meta, body, live.asset));
      return commitVersion(bucket, key, scopes, meta, body, live, commit, lease);
    });
  }

  async function preconditioned(
    bucket: CompatBucket, meta: PutMeta, live: Resolved, write: () => Promise<Result<ObjectInfo>>,
  ): Promise<Result<ObjectInfo>> {
    if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== (await describe(bucket, live))?.generation) {
      return fail({ code: "precondition_failed" });
    }
    return write();
  }

  async function commitVersion(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, live: Resolved, commit: UploadCommit,
    lease: LeaseToken,
  ): Promise<Result<ObjectInfo>> {
    if (commit.overwritingAssetId !== null && commit.overwritingAssetId !== live.asset.id) return fail({ code: "precondition_failed" });
    return preconditioned(bucket, meta, live, async () => {
      if (commit.overwritingAssetId === null && !(await commit.overwrite(live.asset.id))) return fail({ code: "busy" });
      const beat = beating(body.stream, commit.ownedSince, async () => (await compat.renewLease(bucket.name, key, lease, now())) && commit.heartbeat());
      return writeVersion(bucket, key, scopes, meta, { ...body, stream: beat.stream }, live.asset, {
        versionId: commit.versionId,
        publish: {
          of: (version) => publishing(bucket, key, commit, { kind: "lease", token: lease, assetId: live.asset.id }, live.asset, version),
          applied: async () => (await deps.versions.find(commit.versionId)) !== null,
        },
        lost: beat.lost,
      });
    });
  }

  function publishing(
    bucket: CompatBucket, key: ObjectKey, commit: UploadCommit, hold: Pick<CompatPublish["hold"], "kind" | "token" | "assetId">,
    asset: AssetMetadata, version: AssetVersion | null,
  ): CompatPublish {
    const current = version ?? asset;
    return {
      upload: commit.hold(),
      hold: { ...hold, bucket: bucket.name, key },
      record: { objectRef: current.id, hashes: commit.hashes },
      result: unissued(infoOf(bucket, key, asset, version, { generation: 0, hashes: commit.hashes })),
      reclaim: commit.leftovers(),
    };
  }

  function takeLease(bucket: CompatBucket, key: ObjectKey, token: LeaseToken): Promise<boolean> {
    const at = now();
    return compat.lease(bucket.name, key, token, at, at - HOLD_STALE_MS);
  }

  function beating(
    source: ReadableStream<Uint8Array>, since: number, beat: () => Promise<boolean>,
  ): { stream: ReadableStream<Uint8Array>; lost(): boolean } {
    const reader = source.getReader();
    let last = since;
    let lost = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (now() - last >= HEARTBEAT_MS) {
          lost = !(await beat());
          if (lost) throw new HoldLost();
          last = now();
        }
        const { done, value } = await reader.read().catch((e) => {
          if (e instanceof HoldLost) lost = true;
          throw e;
        });
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });
    return { stream, lost: () => lost };
  }

  async function leased<T>(bucket: CompatBucket, key: ObjectKey, work: (token: LeaseToken) => Promise<Result<T>>): Promise<Result<T>> {
    const token = newLeaseToken();
    if (!(await takeLease(bucket, key, token))) return fail({ code: "busy" });
    try {
      return await work(token);
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

  async function open(raw: string, key: ObjectKey): Promise<Result<OpenObject>> {
    const auth = await authorized(raw, "read_asset");
    if (!auth.ok) return auth;
    const r = await resolve(auth.value.bucket, key);
    const info = r && await describe(auth.value.bucket, r);
    if (!r || !info) return fail({ code: "no_such_key" });
    return { ok: true, value: { resolved: { asset: r.asset, version: r.version }, info } as OpenObject };
  }

  return {
    async head(raw, key) {
      const opened = await open(raw, key);
      return opened.ok ? { ok: true, value: opened.value.info } : opened;
    },

    open,

    async list(raw, query) {
      const auth = await authorized(raw, "read_asset");
      if (!auth.ok) return auth;
      const { bucket } = auth.value;
      const page = await listPage(
        { ...query, maxResults: Math.min(query.maxResults, LIST_PAGE_CAP) },
        (from, until, limit) => compat.scanBindings(bucket.name, from, until, limit),
      );
      if (!page) return fail({ code: "invalid", message: "Invalid pageToken." });
      const loaded = await Promise.all(page.objects.map((binding) => binding.kind === "object" ? load(bucket, binding) : null));
      const objects = await describeAll(bucket, loaded.filter((r): r is Resolved => r !== null));
      return { ok: true, value: { objects, prefixes: page.prefixes, nextPageToken: page.nextPageToken } };
    },

    async put(raw, key, meta, body, commit) {
      const auth = await authorized(raw, "create_asset");
      if (!auth.ok) return auth;
      const { bucket, project } = auth.value;
      const scopes = scopesOf(project);
      for (let attempt = 0; attempt < 2; attempt++) {
        const live = await resolve(bucket, key);
        if (commit?.overwritingAssetId && live?.asset.id !== commit.overwritingAssetId) return fail({ code: "precondition_failed" });
        if (live) return overwrite(raw, bucket, key, scopes, meta, body, commit);
        if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== 0) return fail({ code: "precondition_failed" });
        const at = now();
        const claim = await compat.claim(bucket.name, key, "object", at, at - HOLD_STALE_MS);
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

function refOf(r: Resolved): string {
  return r.version?.id ?? r.asset.id;
}

/** `info` before its publish issues the generation. */
function unissued({ generation: _, ...info }: ObjectInfo): Omit<ObjectInfo, "generation"> {
  return info;
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

function infoOf(
  bucket: CompatBucket, key: ObjectKey, asset: AssetMetadata, version: AssetVersion | null, record: VersionRecord,
): ObjectInfo {
  const current = version ?? asset;
  return {
    bucket: bucket.name,
    key,
    size: current.size,
    contentType: current.contentType,
    contentEncoding: current.contentEncoding ?? null,
    generation: record.generation,
    metageneration: 1,
    etag: version?.id ?? asset.id,
    created: new Date(current.createdAt),
    updated: new Date(current.createdAt),
    hashes: record.hashes,
    userMeta: stringMeta(current.userMeta),
  };
}
