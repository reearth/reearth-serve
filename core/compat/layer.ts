import type { Deps } from "../types";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { Project } from "../project/model";
import { authorizeService } from "../auth/access";
import type { ProjectAction } from "../auth/permissions";
import type { ServicePrincipal } from "../auth/types";
import { uploadAsset } from "../asset/usecase/upload";
import { uploadVersion } from "../asset/usecase/upload-version";
import { deleteAsset } from "../asset/usecase/delete";
import { resolveAssetVersion } from "../asset/usecase/resolve-version";
import { siteHostDepsFrom } from "../site/handler";
import { hashingStream, type HashingStream } from "./hash";
import { listPage, type ListQuery } from "./list";
import type { ClaimToken } from "./repository";
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

export interface ObjectLayer {
  head(bucket: string, key: ObjectKey): Promise<Result<ObjectInfo>>;
  list(bucket: string, query: ListQuery): Promise<Result<ListPage>>;
  put(bucket: string, key: ObjectKey, meta: PutMeta, body: SizedBody): Promise<Result<ObjectInfo>>;
  delete(bucket: string, key: ObjectKey): Promise<Result<void>>;
}

export const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Each listed object costs a few point reads, and a Worker invocation may run
 * at most 1,000 D1 queries, so a page stops short of GCS's 1,000 items. The
 * client follows `nextPageToken` either way.
 */
export const LIST_PAGE_CAP = 200;

type Resolved = { binding: Extract<Binding, { kind: "object" }>; asset: AssetMetadata; version: AssetVersion | null };

const fail = (error: CompatError): { ok: false; error: CompatError } => ({ ok: false, error });

export function objectLayer(deps: ObjectLayerDeps, service: ServicePrincipal, now: () => number = Date.now): ObjectLayer {
  const { compat } = deps;

  async function authorized(raw: string, action: ProjectAction): Promise<Result<{ bucket: CompatBucket; project: Project }>> {
    const name = parseBucketName(raw);
    const bucket = name ? await compat.findBucket(name) : null;
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
    const hashes = await compat.findHashes(r.version?.id ?? r.asset.id);
    return infoOf(bucket, r.binding.key, r.asset, r.version, hashes);
  }

  async function writeVersion(
    bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, asset: AssetMetadata,
  ): Promise<Result<ObjectInfo>> {
    const hashed = hashedBody(body);
    const result = await uploadVersion(deps.metadata, deps.writes, deps.storage, asset.id, fileOf(key, meta, body, hashed.stream), deps.baseUrl, {
      extractionQueue: deps.extractionQueue,
      thumbnailQueue: deps.thumbnailQueue,
      usageScopes: scopes,
      siteHostSuffix: deps.siteHostSuffix,
      userMeta: meta.userMeta,
    });
    if (!result) return fail({ code: "busy" });
    const hashes = await hashed.digest();
    await compat.putHashes(result.version.id, asset.id, hashes);
    return { ok: true, value: infoOf(bucket, key, asset, result.version, hashes) };
  }

  async function writeAsset(bucket: CompatBucket, key: ObjectKey, scopes: string[], meta: PutMeta, body: SizedBody, token: ClaimToken): Promise<Result<ObjectInfo>> {
    const hashed = hashedBody(body);
    let asset: AssetMetadata;
    try {
      ({ asset } = await uploadAsset(deps.writes, deps.storage, fileOf(key, meta, body, hashed.stream), deps.ttlSeconds, deps.baseUrl, {
        projectId: bucket.projectId,
        extractionQueue: deps.extractionQueue,
        thumbnailQueue: deps.thumbnailQueue,
        usageScopes: scopes,
        siteHostSuffix: deps.siteHostSuffix,
        userMeta: meta.userMeta,
      }));
    } catch (e) {
      await compat.releaseClaim(bucket.name, key, token);
      throw e;
    }
    const hashes = await hashed.digest();
    await compat.putHashes(asset.id, asset.id, hashes);
    if (!(await compat.bind(bucket.name, key, token, asset.id))) {
      await removeAsset(asset, scopes);
      return fail({ code: "busy" });
    }
    return { ok: true, value: infoOf(bucket, key, asset, null, hashes) };
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

    async put(raw, key, meta, body) {
      const auth = await authorized(raw, "create_asset");
      if (!auth.ok) return auth;
      const { bucket, project } = auth.value;
      const scopes = scopesOf(project);
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = await resolve(bucket, key);
        if (existing) {
          if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== generationOf(existing.version)) {
            return fail({ code: "precondition_failed" });
          }
          const update = await authorized(raw, "update_asset");
          if (!update.ok) return update;
          return writeVersion(bucket, key, scopes, meta, body, existing.asset);
        }
        if (meta.ifGenerationMatch !== null && meta.ifGenerationMatch !== 0) return fail({ code: "precondition_failed" });
        const at = now();
        const claim = await compat.claim(bucket.name, key, "object", at, at - CLAIM_STALE_MS);
        if (claim.kind === "busy") return fail({ code: "busy" });
        if (claim.kind === "claimed") return writeAsset(bucket, key, scopes, meta, body, claim.token);
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
      const binding = await compat.findBinding(bucket.name, key);
      if (binding?.kind !== "object") return { ok: true, value: undefined };
      const asset = await deps.metadata.find(binding.assetId);
      if (!asset || asset.projectId !== bucket.projectId) {
        await compat.deleteBinding(bucket.name, key);
        return { ok: true, value: undefined };
      }
      await removeAsset(asset, scopesOf(project));
      return { ok: true, value: undefined };
    },
  };
}

function hashedBody(body: SizedBody): Pick<HashingStream, "stream" | "digest"> {
  const known = body.hashes;
  return known ? { stream: body.stream, digest: async () => known } : hashingStream(body.stream);
}

function scopesOf(project: Project): string[] {
  return project.workspaceId ? [`project:${project.id}`, `workspace:${project.workspaceId}`] : [`project:${project.id}`];
}

function generationOf(version: AssetVersion | null): number {
  return (version?.version ?? 0) + 1;
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
  bucket: CompatBucket, key: ObjectKey, asset: AssetMetadata, version: AssetVersion | null, hashes: ExactHashes | null,
): ObjectInfo {
  const current = version ?? asset;
  return {
    bucket: bucket.name,
    key,
    size: current.size,
    contentType: current.contentType,
    contentEncoding: current.contentEncoding ?? null,
    generation: generationOf(version),
    metageneration: 1,
    etag: version?.id ?? asset.id,
    created: new Date(current.createdAt),
    updated: new Date(current.createdAt),
    hashes,
    userMeta: stringMeta(current.userMeta),
  };
}
