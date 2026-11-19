import type {
  Binding, BindingKind, BucketName, CompatBucket, CompatCredential, CredentialId,
  UploadId, UploadPhase, UploadSession,
} from "../../core/compat/model";
import {
  newClaimToken, type BindingKey, type ClaimResult, type ClaimToken, type CompatStore, type DeleteBucketResult,
  type LeaseToken, type UploadTransition, type VersionRecord,
} from "../../core/compat/repository";
import { isServiceRole } from "../../core/auth/types";
import type { WriteGuard } from "../../core/asset/repository";

type Row = {
  bucket: BucketName; key: string; kind: BindingKind; assetId: string | null; claimedAt: number; claimToken: ClaimToken;
  lease: { token: LeaseToken; at: number } | null;
};

export class MemoryCompatStore implements CompatStore {
  readonly buckets = new Map<string, CompatBucket>();
  readonly bindings = new Map<string, Row>();
  readonly hashes = new Map<string, { assetId: string; record: VersionRecord }>();
  readonly generations = new Map<string, number>();
  readonly credentials = new Map<string, CompatCredential>();
  readonly uploads = new Map<string, UploadSession>();

  async findBucket(name: BucketName): Promise<CompatBucket | null> {
    return this.buckets.get(name) ?? null;
  }
  async listBuckets(projectId: string): Promise<CompatBucket[]> {
    return [...this.buckets.values()].filter((b) => b.projectId === projectId).sort((a, b) => cmp(a.name, b.name));
  }
  async insertBucket(bucket: CompatBucket): Promise<boolean> {
    if (this.buckets.has(bucket.name)) return false;
    this.buckets.set(bucket.name, { ...bucket });
    return true;
  }
  async deleteBucket(projectId: string, name: BucketName, revokedAt: number): Promise<DeleteBucketResult> {
    if (this.buckets.get(name)?.projectId !== projectId) return "absent";
    if ([...this.bindings.values()].some((r) => r.bucket === name)) return "not_empty";
    for (const c of this.credentials.values()) {
      if (c.bucket === name && c.revokedAt === null) this.credentials.set(c.id, { ...c, revokedAt });
    }
    for (const u of this.uploads.values()) if (u.bucket === name) this.uploads.delete(u.id);
    this.buckets.delete(name);
    this.generations.delete(name);
    return "deleted";
  }
  async deleteProject(projectId: string): Promise<void> {
    const names = new Set([...this.buckets.values()].filter((b) => b.projectId === projectId).map((b) => b.name));
    for (const [id, row] of this.bindings) if (names.has(row.bucket)) this.bindings.delete(id);
    for (const [id, u] of this.uploads) if (names.has(u.bucket)) this.uploads.delete(id);
    for (const [id, c] of this.credentials) if (c.projectId === projectId) this.credentials.delete(id);
    for (const name of names) {
      this.buckets.delete(name);
      this.generations.delete(name);
    }
  }

  async findBinding(bucket: BucketName, key: BindingKey): Promise<Binding | null> {
    const row = this.bindings.get(rowKey(bucket, key));
    return row ? toBinding(row) : null;
  }
  async claim(bucket: BucketName, key: BindingKey, kind: BindingKind, now: number, staleBefore: number): Promise<ClaimResult> {
    const id = rowKey(bucket, key);
    const row = this.bindings.get(id);
    if (!row || (row.assetId === null && row.claimedAt < staleBefore)) {
      const token = newClaimToken();
      this.bindings.set(id, { bucket, key, kind, assetId: null, claimedAt: now, claimToken: token, lease: null });
      return { kind: "claimed", token };
    }
    const binding = toBinding(row);
    return binding ? { kind: "bound", binding } : { kind: "busy" };
  }
  async bind(bucket: BucketName, key: BindingKey, token: ClaimToken, assetId: string, upload?: UploadTransition): Promise<boolean> {
    const row = this.bindings.get(rowKey(bucket, key));
    if (!row || (row.assetId !== assetId && (row.assetId !== null || row.claimToken !== token))) return false;
    if (upload && !(await this.updateUpload(upload.id, upload.revision, upload.phase))) return false;
    row.assetId = assetId;
    return true;
  }
  async releaseClaim(bucket: BucketName, key: BindingKey, token: ClaimToken): Promise<void> {
    const id = rowKey(bucket, key);
    const row = this.bindings.get(id);
    if (row && row.assetId === null && row.claimToken === token) this.bindings.delete(id);
  }
  async deleteBinding(bucket: BucketName, key: BindingKey): Promise<void> {
    this.bindings.delete(rowKey(bucket, key));
  }
  async lease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number, staleBefore: number): Promise<boolean> {
    const row = this.bindings.get(rowKey(bucket, key));
    if (!row || row.assetId === null || (row.lease !== null && row.lease.at >= staleBefore)) return false;
    row.lease = { token, at: now };
    return true;
  }
  async renewLease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number): Promise<boolean> {
    const row = this.bindings.get(rowKey(bucket, key));
    if (row?.lease?.token !== token) return false;
    row.lease = { token, at: now };
    return true;
  }
  async renewClaim(bucket: BucketName, key: BindingKey, token: ClaimToken, now: number): Promise<boolean> {
    const row = this.bindings.get(rowKey(bucket, key));
    if (!row || row.assetId !== null || row.claimToken !== token) return false;
    row.claimedAt = now;
    return true;
  }
  async releaseLease(bucket: BucketName, key: BindingKey, token: LeaseToken): Promise<void> {
    const row = this.bindings.get(rowKey(bucket, key));
    if (row?.lease?.token === token) row.lease = null;
  }
  async scanBindings(bucket: BucketName, from: string, until: string | null, limit: number): Promise<Binding[]> {
    return [...this.bindings.values()]
      .filter((r) => r.bucket === bucket && cmp(r.key, from) >= 0 && (until === null || cmp(r.key, until) < 0))
      .sort((a, b) => cmp(a.key, b.key))
      .flatMap((r) => toBinding(r) ?? [])
      .slice(0, limit);
  }

  async nextGeneration(bucket: BucketName, atLeast: number): Promise<number> {
    if (!this.buckets.has(bucket)) return atLeast;
    const next = Math.max((this.generations.get(bucket) ?? 0) + 1, atLeast);
    this.generations.set(bucket, next);
    return next;
  }
  async findRecord(objectRef: string): Promise<VersionRecord | null> {
    return this.hashes.get(objectRef)?.record ?? null;
  }
  async putRecord(objectRef: string, assetId: string, record: VersionRecord): Promise<void> {
    this.hashes.set(objectRef, { assetId, record });
  }

  async findCredential(id: CredentialId): Promise<CompatCredential | null> {
    return this.credentials.get(id) ?? null;
  }
  async findCredentialByEmail(clientEmail: string): Promise<CompatCredential | null> {
    return [...this.credentials.values()].find((c) => c.clientEmail === clientEmail) ?? null;
  }
  async insertCredential(credential: CompatCredential): Promise<boolean> {
    if (!isServiceRole(credential.role)) throw new Error(`CHECK constraint failed: role ${credential.role}`);
    const taken = [...this.credentials.values()].some((c) => c.id === credential.id || c.clientEmail === credential.clientEmail);
    if (taken) throw new Error(`credential ${credential.id} already exists`);
    if (this.buckets.get(credential.bucket)?.projectId !== credential.projectId) return false;
    this.credentials.set(credential.id, { ...credential });
    return true;
  }
  async listCredentials(projectId: string): Promise<CompatCredential[]> {
    return [...this.credentials.values()]
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
  }
  async revokeCredential(projectId: string, id: CredentialId, at: number): Promise<boolean> {
    const c = this.credentials.get(id);
    if (!c || c.projectId !== projectId) return false;
    this.credentials.set(id, { ...c, revokedAt: c.revokedAt ?? at });
    return true;
  }

  async createUpload(session: UploadSession): Promise<void> {
    if (this.uploads.has(session.id)) throw new Error(`upload ${session.id} already exists`);
    this.uploads.set(session.id, structuredClone(session));
  }
  async findUpload(id: UploadId): Promise<UploadSession | null> {
    const u = this.uploads.get(id);
    return u ? structuredClone(u) : null;
  }
  async updateUpload(id: UploadId, revision: number, phase: UploadPhase): Promise<boolean> {
    const u = this.uploads.get(id);
    if (!u || u.revision !== revision) return false;
    this.uploads.set(id, { ...u, revision: revision + 1, phase: structuredClone(phase) });
    return true;
  }
  async listExpiredUploads(now: number, limit: number): Promise<UploadSession[]> {
    return [...this.uploads.values()]
      .filter((u) => u.expiresAt < now)
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, limit);
  }
  async deleteUpload(id: UploadId, revision?: number): Promise<boolean> {
    const u = this.uploads.get(id);
    if (!u || (revision !== undefined && u.revision !== revision)) return false;
    return this.uploads.delete(id);
  }
  async sweepStaleHolds(staleBefore: number): Promise<{ claims: number; leases: number }> {
    let claims = 0;
    let leases = 0;
    for (const [id, row] of this.bindings) {
      if (row.assetId === null && row.claimedAt < staleBefore) {
        this.bindings.delete(id);
        claims++;
      } else if (row.lease !== null && row.lease.at < staleBefore) {
        row.lease = null;
        leases++;
      }
    }
    return { claims, leases };
  }

  holds(guard: WriteGuard): boolean {
    if (this.uploads.get(guard.upload.id)?.revision !== guard.upload.revision) return false;
    if (!guard.lease) return true;
    const row = this.bindings.get(rowKey(guard.lease.bucket, guard.lease.key));
    return row?.lease?.token === guard.lease.token && row.assetId === guard.lease.assetId;
  }

  dropAsset(assetId: string): void {
    for (const [id, row] of this.bindings) if (row.assetId === assetId) this.bindings.delete(id);
    for (const [ref, h] of this.hashes) if (h.assetId === assetId) this.hashes.delete(ref);
  }
}

function rowKey(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function toBinding(row: Row): Binding | null {
  if (row.assetId === null) return null;
  return row.kind === "folder"
    ? { kind: "folder", bucket: row.bucket, key: row.key as Extract<Binding, { kind: "folder" }>["key"], assetId: row.assetId }
    : { kind: "object", bucket: row.bucket, key: row.key as Extract<Binding, { kind: "object" }>["key"], assetId: row.assetId };
}

/** SQLite's default BINARY collation, which orders by UTF-8 bytes, not UTF-16 code units. */
function cmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
