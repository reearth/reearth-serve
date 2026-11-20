import type { Deps } from "../types";
import { HoldLost, type FileStorage } from "../asset/repository";
import type { ServicePrincipal } from "../auth/types";
import { deleteAllR2Objects, SubrequestBudget } from "../cleanup/usecase";
import { createHasher, hashingStream, initialHashState, type HashState } from "./hash";
import {
  authorizeBucket, HOLD_STALE_MS, lengthChecked, type CommitIds, type ObjectLayer, type ObjectLayerDeps, type UploadCommit,
} from "./layer";
import type {
  CommitOwner, CompatError, CredentialId, ExactHashes, ObjectInfo, ObjectKey, PutMeta, Result, StagedPart, UploadId,
  UploadPhase, UploadSession,
} from "./model";

/** As long as GCS keeps a resumable session URI. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SWEEP_SESSIONS_PER_TICK = 50;

const STAGING_DELETE_BUDGET = 20;

export type Chunk = { start: number | null; size: number; total: number | null };

export type ChunkDecision =
  | { kind: "stage"; final: boolean; total: number | null }
  | { kind: "commit" }
  | { kind: "ack" }
  | { kind: "reject"; error: CompatError };

export type UploadStatus = { kind: "incomplete"; received: number } | { kind: "committed"; info: ObjectInfo };

export type DeclaredHashes = { crc32c: number | null; md5: Uint8Array | null };

type Open = Extract<UploadPhase, { state: "open" }>;
type Committing = Extract<UploadPhase, { state: "committing" }>;
type Held = Committing & { owner: CommitOwner };
type Published = Extract<UploadPhase, { state: "published" }>;

function ownedAt(phase: UploadPhase, at: number): boolean {
  return phase.state === "committing" && phase.owner !== null && phase.owner.since >= at - HOLD_STALE_MS;
}

const GONE: UploadPhase = { state: "failed", error: { code: "no_such_upload" } };

const invalid = (message: string): ChunkDecision => ({ kind: "reject", error: { code: "invalid", message } });

export function applyChunk(session: UploadSession, chunk: Chunk, now: number): ChunkDecision {
  const { phase } = session;
  if (phase.state === "committed" || phase.state === "published") return { kind: "ack" };
  if (phase.state === "failed") return { kind: "reject", error: phase.error };
  if (now >= session.expiresAt) return { kind: "reject", error: { code: "no_such_upload" } };
  if (phase.state === "committing") return finalizing(phase.size, chunk.total);
  if (chunk.total !== null && phase.total !== null && chunk.total !== phase.total) {
    return invalid(`The upload's total is ${phase.total} bytes, not ${chunk.total}.`);
  }
  const total = chunk.total ?? phase.total;
  if (chunk.start === null) return finalizing(phase.received, total);
  const end = chunk.start + chunk.size;
  if (total !== null && end > total) return invalid(`The chunk ends at byte ${end}, past the total of ${total} bytes.`);
  if (chunk.start < phase.received && end <= phase.received) return { kind: "ack" };
  if (chunk.start !== phase.received) {
    return invalid(`The chunk starts at byte ${chunk.start}, but the upload holds ${phase.received} bytes.`);
  }
  return { kind: "stage", final: end === total, total };
}

function finalizing(received: number, total: number | null): ChunkDecision {
  if (total === received) return { kind: "commit" };
  return invalid(total === null
    ? `The upload holds ${received} bytes, but the request declares no total.`
    : `The upload holds ${received} bytes, not ${total}.`);
}

export function stagingPrefix(id: UploadId): string {
  return `compat-staging/${id}/`;
}

function stagingKey(id: UploadId, start: number): string {
  return `${stagingPrefix(id)}${String(start).padStart(16, "0")}-${crypto.randomUUID()}`;
}

async function commitIdsOf(id: UploadId, token: string): Promise<CommitIds> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`compat-upload:${id}:${token}`)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return { assetId: hex.slice(0, 16), versionId: hex.slice(16, 32) };
}

function stagedStream(storage: FileStorage, parts: StagedPart[]): ReadableStream<Uint8Array> {
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (next >= parts.length) {
            controller.close();
            return;
          }
          const part = parts[next++];
          const staged = await storage.get(part.key);
          if (!staged) throw new HoldLost();
          reader = (staged.body as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

function declaredMismatch(declared: DeclaredHashes, actual: ExactHashes): string | null {
  if (declared.crc32c !== null && declared.crc32c !== actual.crc32c) return "Provided CRC32C does not match the uploaded data.";
  if (declared.md5 && declared.md5.some((b, i) => b !== actual.md5[i])) return "Provided MD5 hash does not match the uploaded data.";
  return null;
}

const fail = (error: CompatError): { ok: false; error: CompatError } => ({ ok: false, error });

const committed = (info: ObjectInfo): Result<UploadStatus> => ({ ok: true, value: { kind: "committed", info } });

export interface ResumableUploads {
  begin(bucket: string, key: ObjectKey, meta: PutMeta): Promise<Result<UploadId>>;
  append(id: string, bucket: string, chunk: Chunk, body: ReadableStream<Uint8Array> | null, declared: DeclaredHashes): Promise<Result<UploadStatus>>;
  status(id: string, bucket: string): Promise<Result<UploadStatus>>;
  cancel(id: string, bucket: string): Promise<Result<void>>;
}

export function resumableUploads(
  deps: ObjectLayerDeps, service: ServicePrincipal, layer: ObjectLayer, now: () => number = Date.now,
): ResumableUploads {
  const { compat, storage } = deps;

  async function sessionFor(id: string, bucket: string): Promise<Result<UploadSession>> {
    const session = await compat.findUpload(id as UploadId);
    if (!session || session.bucket !== bucket) return fail({ code: "no_such_upload" });
    if (session.credentialId !== service.id) return fail({ code: "forbidden" });
    return { ok: true, value: session };
  }

  async function settled(id: UploadId, info?: ObjectInfo): Promise<Result<UploadStatus>> {
    const session = await compat.findUpload(id);
    if (info && (!session || session.phase.state === "failed")) return committed(info);
    if (!session) return fail({ code: "no_such_upload" });
    if (session.phase.state === "committing") return fail({ code: "busy" });
    return answer(session, info);
  }

  async function answer(session: UploadSession, info?: ObjectInfo): Promise<Result<UploadStatus>> {
    const { phase } = session;
    switch (phase.state) {
      case "open": return { ok: true, value: { kind: "incomplete", received: phase.received } };
      case "committing": return { ok: true, value: { kind: "incomplete", received: phase.size } };
      case "published": return finish(session, phase, info);
      case "committed": return committed(phase.result);
      case "failed": return fail(phase.error);
    }
  }

  async function finish(session: UploadSession, phase: Published, info?: ObjectInfo): Promise<Result<UploadStatus>> {
    const finished = info
      ? { ok: true as const, value: info }
      : await layer.finish(session.bucket, session.key, phase.versionId, createHasher(phase.hashState).digest());
    if (!finished.ok) return finished;
    if (await compat.updateUpload(session.id, session.revision, { state: "committed", result: finished.value })) return committed(finished.value);
    return settled(session.id, finished.value);
  }

  const heldBy = (token: string): CommitOwner => ({ token, since: now() });

  function sealed(received: number, hashState: HashState, parts: StagedPart[]): Held {
    const token = crypto.randomUUID();
    return { state: "committing", size: received, hashState, parts, owner: heldBy(token), ownerTokens: [token], overwritingAssetId: null };
  }

  async function stage(
    session: UploadSession, open: Open, start: number, size: number, body: ReadableStream<Uint8Array> | null,
    decision: Extract<ChunkDecision, { kind: "stage" }>, declared: DeclaredHashes,
  ): Promise<Result<UploadStatus>> {
    const key = stagingKey(session.id, start);
    const counted = lengthChecked(body ?? new Blob([]).stream(), size);
    const hashed = hashingStream(counted.stream, open.hashState);
    try {
      await storage.put(key, hashed.stream, "application/octet-stream", size);
    } catch (e) {
      if (counted.lengthMismatched()) return fail({ code: "invalid", message: "The chunk does not match its Content-Range." });
      throw e;
    }
    const hashState = await hashed.state();
    const received = start + size;
    const parts = [...open.parts, { key, size }];
    const mismatch = decision.final ? declaredMismatch(declared, createHasher(hashState).digest()) : null;
    const next: Held | Open = decision.final
      ? sealed(received, hashState, parts)
      : { state: "open", received, total: decision.total, hashState, parts };
    if (mismatch || !(await compat.updateUpload(session.id, session.revision, next))) {
      await storage.delete(key);
      return mismatch ? fail({ code: "invalid", message: mismatch }) : settled(session.id);
    }
    if (next.state === "committing") return commit({ ...session, revision: session.revision + 1 }, next);
    return { ok: true, value: { kind: "incomplete", received } };
  }

  async function seal(session: UploadSession, open: Open, declared: DeclaredHashes): Promise<Result<UploadStatus>> {
    const mismatch = declaredMismatch(declared, createHasher(open.hashState).digest());
    if (mismatch) return fail({ code: "invalid", message: mismatch });
    const next = sealed(open.received, open.hashState, open.parts);
    if (!(await compat.updateUpload(session.id, session.revision, next))) return settled(session.id);
    return commit({ ...session, revision: session.revision + 1 }, next);
  }

  async function takeOver(session: UploadSession, phase: Committing): Promise<Result<UploadStatus>> {
    if (ownedAt(phase, now())) return fail({ code: "busy" });
    const token = crypto.randomUUID();
    const next: Held = { ...phase, owner: heldBy(token), ownerTokens: [...phase.ownerTokens, token] };
    if (!(await compat.updateUpload(session.id, session.revision, next))) return settled(session.id);
    return commit({ ...session, revision: session.revision + 1 }, next);
  }

  async function commit(session: UploadSession, held: Held): Promise<Result<UploadStatus>> {
    let revision = session.revision;
    let current: Committing = held;
    const tokens = [...held.ownerTokens].reverse();
    const [own, ...earlier] = await Promise.all(tokens.map((token) => commitIdsOf(session.id, token)));
    const advance = async (next: Committing) => {
      if (!(await compat.updateUpload(session.id, revision, next))) return false;
      revision++;
      current = next;
      return true;
    };
    const handle: UploadCommit = {
      ...own,
      earlier,
      overwritingAssetId: held.overwritingAssetId,
      ownedSince: held.owner.since,
      publish: { state: "published", versionId: own.versionId, hashState: held.hashState },
      overwrite: (assetId) => advance({ ...current, overwritingAssetId: assetId }),
      heartbeat: () => advance({ ...current, owner: heldBy(tokens[0]) }),
      hold: () => ({ id: session.id, revision }),
      committedTransition: (result) => ({ id: session.id, revision, phase: { state: "committed", result } }),
    };
    const release = () => compat.updateUpload(session.id, revision, { ...current, owner: null });
    const body = { stream: stagedStream(storage, held.parts), size: held.size, hashes: createHasher(held.hashState).digest() };
    let put: Result<ObjectInfo>;
    try {
      put = await layer.put(session.bucket, session.key, session.meta, body, handle);
    } catch (e) {
      await release().catch(() => false);
      throw e;
    }
    if (put.ok) {
      const done = await settled(session.id, put.value);
      await dropStaging(session.id);
      return done;
    }
    if (put.error.code === "busy") {
      await release();
      return put;
    }
    if (await compat.updateUpload(session.id, revision, { state: "failed", error: put.error })) await dropStaging(session.id);
    return put;
  }

  async function dropStaging(id: UploadId): Promise<void> {
    const prefix = stagingPrefix(id);
    const dropped = await deleteAllR2Objects(storage, prefix, new SubrequestBudget(STAGING_DELETE_BUDGET)).catch((e) => {
      console.error(`compat: staged chunks of upload ${id} left for the sweep:`, e);
      return { done: false };
    });
    if (!dropped.done) await deps.pendingCleanup.add(prefix);
  }

  return {
    async begin(raw, key, meta) {
      const auth = await authorizeBucket(deps, service, raw, "create_asset");
      if (!auth.ok) return auth;
      const session: UploadSession = {
        id: crypto.randomUUID().replaceAll("-", "") as UploadId,
        bucket: auth.value.bucket.name,
        key,
        credentialId: service.id as CredentialId,
        meta,
        expiresAt: now() + UPLOAD_TTL_MS,
        revision: 0,
        phase: { state: "open", received: 0, total: null, hashState: initialHashState, parts: [] },
      };
      await compat.createUpload(session);
      return { ok: true, value: session.id };
    },

    async append(id, bucket, chunk, body, declared) {
      const found = await sessionFor(id, bucket);
      if (!found.ok) {
        await body?.cancel();
        return found;
      }
      const session = found.value;
      const { phase } = session;
      const decision = applyChunk(session, chunk, now());
      if (decision.kind === "stage" && phase.state === "open" && chunk.start !== null) {
        return stage(session, phase, chunk.start, chunk.size, body, decision, declared);
      }
      await body?.cancel();
      switch (decision.kind) {
        case "reject": return fail(decision.error);
        case "commit":
          if (phase.state === "open") return seal(session, phase, declared);
          if (phase.state === "committing") return takeOver(session, phase);
          return answer(session);
        default: return answer(session);
      }
    },

    async status(id, bucket) {
      const found = await sessionFor(id, bucket);
      return found.ok ? answer(found.value) : found;
    },

    async cancel(id, bucket) {
      const found = await sessionFor(id, bucket);
      if (!found.ok) return found;
      const { phase, revision } = found.value;
      if (phase.state === "published" || ownedAt(phase, now()) || !(await compat.updateUpload(id as UploadId, revision, GONE))) {
        return fail({ code: "busy" });
      }
      await dropStaging(id as UploadId);
      await compat.deleteUpload(id as UploadId, revision + 1);
      return { ok: true, value: undefined };
    },
  };
}

export async function sweepUploads(deps: Pick<Deps, "compat" | "pendingCleanup">, now: number) {
  const expired = await deps.compat.listExpiredUploads(now, SWEEP_SESSIONS_PER_TICK);
  let sessions = 0;
  for (const session of expired) {
    if (ownedAt(session.phase, now) || !(await deps.compat.updateUpload(session.id, session.revision, GONE))) continue;
    await deps.pendingCleanup.add(stagingPrefix(session.id));
    await deps.compat.deleteUpload(session.id, session.revision + 1);
    sessions++;
  }
  const holds = await deps.compat.sweepStaleHolds(now - HOLD_STALE_MS);
  return { sessions, ...holds };
}
