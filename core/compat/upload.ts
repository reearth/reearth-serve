import type { Deps } from "../types";
import type { FileStorage } from "../asset/repository";
import type { ServicePrincipal } from "../auth/types";
import { deleteAllR2Objects, SubrequestBudget } from "../cleanup/usecase";
import { createHasher, hashingStream, initialHashState, type HashState } from "./hash";
import {
  authorizeBucket, HOLD_STALE_MS, lengthChecked, type ReplayableCommit, type ObjectLayer, type ObjectLayerDeps,
} from "./layer";
import type { ClaimToken, LeaseToken } from "./repository";
import type {
  CompatError, CredentialId, ExactHashes, ObjectInfo, ObjectKey, PutMeta, Result, UploadId, UploadSession,
} from "./model";

/** As long as GCS keeps a resumable session URI. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SWEEP_SESSIONS_PER_TICK = 50;

const STAGING_DELETE_BUDGET = 20;

export type Chunk = { start: number | null; size: number; total: number | null };

export type ChunkDecision =
  | { kind: "stage"; final: boolean }
  | { kind: "commit" }
  | { kind: "ack" }
  | { kind: "reject"; error: CompatError };

export type UploadStatus = { kind: "incomplete"; received: number } | { kind: "committed"; info: ObjectInfo };

export type DeclaredHashes = { crc32c: number | null; md5: Uint8Array | null };

const invalid = (message: string): ChunkDecision => ({ kind: "reject", error: { code: "invalid", message } });

export function applyChunk(session: UploadSession, chunk: Chunk, now: number): ChunkDecision {
  const { received } = session;
  if (session.state === "committed") return { kind: "ack" };
  if (now >= session.expiresAt) return { kind: "reject", error: { code: "no_such_upload" } };
  if (session.state === "committing" || chunk.start === null) {
    if (chunk.total === received) return { kind: "commit" };
    return invalid(`The upload holds ${received} bytes, not ${chunk.total ?? "an unknown number of"}.`);
  }
  const end = chunk.start + chunk.size;
  if (chunk.start < received && end <= received) return { kind: "ack" };
  if (chunk.start !== received) return invalid(`The chunk starts at byte ${chunk.start}, but the upload holds ${received} bytes.`);
  return { kind: "stage", final: end === chunk.total };
}

export function stagingPrefix(id: UploadId): string {
  return `compat-staging/${id}/`;
}

function stagingKey(id: UploadId, start: number): string {
  return `${stagingPrefix(id)}${String(start).padStart(16, "0")}`;
}

async function opaqueReplayableCommitOf(id: UploadId): Promise<ReplayableCommit> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`compat-upload:${id}`)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return { assetId: hex.slice(0, 16), versionId: hex.slice(16, 32), token: `upload:${id}` as ClaimToken & LeaseToken };
}

function stagedStream(storage: FileStorage, id: UploadId, total: number): ReadableStream<Uint8Array> {
  let offset = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (offset >= total) {
            controller.close();
            return;
          }
          const staged = await storage.get(stagingKey(id, offset));
          if (!staged) throw new Error(`upload ${id} has no staged chunk at byte ${offset}`);
          reader = (staged.body as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        offset += value.length;
        controller.enqueue(value);
        return;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function declaredMismatch(declared: DeclaredHashes, actual: ExactHashes): string | null {
  if (declared.crc32c !== null && declared.crc32c !== actual.crc32c) return "Provided CRC32C does not match the uploaded data.";
  if (declared.md5 && declared.md5.some((b, i) => b !== actual.md5[i])) return "Provided MD5 hash does not match the uploaded data.";
  return null;
}

const fail = (error: CompatError): { ok: false; error: CompatError } => ({ ok: false, error });

function statusOf(session: UploadSession): UploadStatus {
  return session.state === "committed" && session.result
    ? { kind: "committed", info: session.result }
    : { kind: "incomplete", received: session.received };
}

export interface ResumableUploads {
  begin(bucket: string, key: ObjectKey, meta: PutMeta): Promise<Result<UploadId>>;
  append(id: string, bucket: string, chunk: Chunk, body: ReadableStream<Uint8Array> | null, declared: DeclaredHashes): Promise<Result<UploadStatus>>;
  status(id: string, bucket: string): Promise<Result<UploadStatus>>;
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

  async function settled(id: UploadId): Promise<Result<UploadStatus>> {
    const session = await compat.findUpload(id);
    if (!session) return fail({ code: "no_such_upload" });
    if (session.state === "committing") return fail({ code: "busy" });
    return { ok: true, value: statusOf(session) };
  }

  async function stage(session: UploadSession, size: number, body: ReadableStream<Uint8Array> | null, final: boolean, declared: DeclaredHashes) {
    const start = session.received;
    const key = stagingKey(session.id, start);
    const counted = lengthChecked(body ?? new Blob([]).stream(), size);
    const hashed = hashingStream(counted.stream, session.hashState);
    try {
      await storage.put(key, hashed.stream, "application/octet-stream", size);
    } catch (e) {
      if (counted.lengthMismatched()) return fail({ code: "invalid", message: "The chunk does not match its Content-Range." });
      throw e;
    }
    const hashState = await hashed.state();
    if (final) return finish(session, start + size, hashState, declared, key);
    const next = { received: start + size, hashState, state: "open" as const, result: null };
    if (!(await compat.advanceUpload(session.id, { received: start, state: "open" }, next))) return settled(session.id);
    return { ok: true as const, value: { kind: "incomplete" as const, received: next.received } };
  }

  async function finish(
    session: UploadSession, total: number, hashState: HashState, declared: DeclaredHashes, stagedKey: string | null,
  ): Promise<Result<UploadStatus>> {
    const mismatch = declaredMismatch(declared, createHasher(hashState).digest());
    if (mismatch) {
      if (stagedKey) await storage.delete(stagedKey);
      return fail({ code: "invalid", message: mismatch });
    }
    const next = { received: total, hashState, state: "committing" as const, result: null };
    if (!(await compat.advanceUpload(session.id, { received: session.received, state: "open" }, next))) return settled(session.id);
    return commit({ ...session, ...next });
  }

  async function commit(session: UploadSession): Promise<Result<UploadStatus>> {
    const body = { stream: stagedStream(storage, session.id, session.received), size: session.received, hashes: createHasher(session.hashState).digest() };
    const put = await layer.put(session.bucket, session.key, session.meta, body, await opaqueReplayableCommitOf(session.id));
    if (!put.ok) return put;
    const done = { received: session.received, hashState: session.hashState, state: "committed" as const, result: put.value };
    await compat.advanceUpload(session.id, { received: session.received, state: "committing" }, done);
    await dropStaging(session.id);
    return { ok: true, value: { kind: "committed", info: put.value } };
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
        received: 0,
        hashState: initialHashState,
        state: "open",
        result: null,
        expiresAt: now() + UPLOAD_TTL_MS,
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
      const decision = applyChunk(session, chunk, now());
      if (decision.kind === "stage") return stage(session, chunk.size, body, decision.final, declared);
      await body?.cancel();
      switch (decision.kind) {
        case "ack": return { ok: true, value: statusOf(session) };
        case "reject": return fail(decision.error);
        case "commit":
          return session.state === "open" ? finish(session, session.received, session.hashState, declared, null) : commit(session);
      }
    },

    async status(id, bucket) {
      const found = await sessionFor(id, bucket);
      return found.ok ? { ok: true, value: statusOf(found.value) } : found;
    },
  };
}

export async function sweepUploads(deps: Pick<Deps, "compat" | "pendingCleanup">, now: number) {
  const expired = await deps.compat.listExpiredUploads(now, SWEEP_SESSIONS_PER_TICK);
  for (const session of expired) {
    await deps.pendingCleanup.add(stagingPrefix(session.id));
    await deps.compat.deleteUpload(session.id);
  }
  const holds = await deps.compat.sweepStaleHolds(now - HOLD_STALE_MS);
  return { sessions: expired.length, ...holds };
}
