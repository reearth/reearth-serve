import type {
  Binding, BindingKind, BucketName, CompatBucket, CompatCredential, CredentialId,
  ExactHashes, UploadId, UploadSession,
} from "../../core/compat/model";
import type { BindingKey, ClaimResult, CompatStore, DeleteBucketResult } from "../../core/compat/repository";
import type { Row, SqlClient, SqlStatement } from "../../core/sql/port";
import { queryAll, queryFirst } from "./helpers";

const BUCKET_COLUMNS = "name, project_id, mount_rule, created_at";
const BINDING_COLUMNS = "bucket, key, binding, asset_id";
const CREDENTIAL_COLUMNS =
  "id, project_id, bucket, role, client_email, public_jwk, label, created_by, created_at, revoked_at";
const UPLOAD_COLUMNS =
  "id, bucket, key, credential_id, meta, received, hash_state, state, result, expires_at";

const BUCKET_IS_EMPTY = "NOT EXISTS (SELECT 1 FROM compat_bindings WHERE bucket = ?2)";
const BUCKET_IN_PROJECT = "EXISTS (SELECT 1 FROM compat_buckets WHERE name = ?2 AND project_id = ?1)";

export class SqlCompatStore implements CompatStore {
  constructor(private db: SqlClient) {}

  async findBucket(name: BucketName): Promise<CompatBucket | null> {
    const row = await queryFirst(this.db, `SELECT ${BUCKET_COLUMNS} FROM compat_buckets WHERE name = ?1`, [name]);
    return row ? parseBucket(row) : null;
  }

  async listBuckets(projectId: string): Promise<CompatBucket[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${BUCKET_COLUMNS} FROM compat_buckets WHERE project_id = ?1 ORDER BY name ASC`,
      [projectId],
    );
    return rows.map(parseBucket);
  }

  async insertBucket(bucket: CompatBucket): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT OR IGNORE INTO compat_buckets (${BUCKET_COLUMNS}) VALUES (?1, ?2, ?3, ?4)`,
      [bucket.name, bucket.projectId, bucket.mount ? JSON.stringify(bucket.mount) : null, bucket.createdAt],
    );
    return result.rowsAffected > 0;
  }

  async deleteBucket(projectId: string, name: BucketName, revokedAt: number): Promise<DeleteBucketResult> {
    const guard = `${BUCKET_IN_PROJECT} AND ${BUCKET_IS_EMPTY}`;
    const results = await this.db.batch([
      {
        sql: `UPDATE compat_credentials SET revoked_at = ?3 WHERE bucket = ?2 AND revoked_at IS NULL AND ${guard}`,
        args: [projectId, name, revokedAt],
      },
      { sql: `DELETE FROM compat_uploads WHERE bucket = ?2 AND ${guard}`, args: [projectId, name] },
      {
        sql: `DELETE FROM compat_buckets WHERE name = ?2 AND project_id = ?1 AND ${BUCKET_IS_EMPTY} RETURNING name`,
        args: [projectId, name],
      },
    ]);
    if (results[2].rows.length > 0) return "deleted";
    const bucket = await this.findBucket(name);
    return bucket?.projectId === projectId ? "not_empty" : "absent";
  }

  async findBinding(bucket: BucketName, key: BindingKey): Promise<Binding | null> {
    const row = await queryFirst(
      this.db,
      `SELECT ${BINDING_COLUMNS} FROM compat_bindings WHERE bucket = ?1 AND key = ?2 AND asset_id IS NOT NULL`,
      [bucket, key],
    );
    return row ? parseBinding(row) : null;
  }

  async claim(bucket: BucketName, key: BindingKey, kind: BindingKind, now: number, staleBefore: number): Promise<ClaimResult> {
    const claimed = await queryFirst(
      this.db,
      `INSERT INTO compat_bindings (bucket, key, binding, asset_id, claimed_at) VALUES (?1, ?2, ?3, NULL, ?4)
         ON CONFLICT (bucket, key) DO UPDATE SET binding = excluded.binding, claimed_at = excluded.claimed_at
           WHERE compat_bindings.asset_id IS NULL AND compat_bindings.claimed_at < ?5
         RETURNING claimed_at`,
      [bucket, key, kind, now, staleBefore],
    );
    if (claimed) return { kind: "claimed", token: now };
    const binding = await this.findBinding(bucket, key);
    return binding ? { kind: "bound", binding } : { kind: "busy" };
  }

  async bind(bucket: BucketName, key: BindingKey, token: number, assetId: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE compat_bindings SET asset_id = ?4
         WHERE bucket = ?1 AND key = ?2 AND ((asset_id IS NULL AND claimed_at = ?3) OR asset_id = ?4)`,
      [bucket, key, token, assetId],
    );
    return result.rowsAffected > 0;
  }

  async releaseClaim(bucket: BucketName, key: BindingKey, token: number): Promise<void> {
    await this.db.execute(
      "DELETE FROM compat_bindings WHERE bucket = ?1 AND key = ?2 AND asset_id IS NULL AND claimed_at = ?3",
      [bucket, key, token],
    );
  }

  async deleteBinding(bucket: BucketName, key: BindingKey): Promise<void> {
    await this.db.execute("DELETE FROM compat_bindings WHERE bucket = ?1 AND key = ?2", [bucket, key]);
  }

  async scanBindings(bucket: BucketName, from: string, until: string | null, limit: number): Promise<Binding[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${BINDING_COLUMNS} FROM compat_bindings
         WHERE bucket = ?1 AND key >= ?2 AND (?3 IS NULL OR key < ?3) AND asset_id IS NOT NULL
         ORDER BY key ASC LIMIT ?4`,
      [bucket, from, until, limit],
    );
    return rows.map(parseBinding);
  }

  async findHashes(objectRef: string): Promise<ExactHashes | null> {
    const row = await queryFirst(this.db, "SELECT md5, crc32c FROM compat_hashes WHERE object_ref = ?1", [objectRef]);
    return row ? { md5: toBytes(row.md5), crc32c: Number(row.crc32c) } : null;
  }

  async putHashes(objectRef: string, assetId: string, hashes: ExactHashes): Promise<void> {
    await this.db.execute(
      "INSERT OR REPLACE INTO compat_hashes (object_ref, asset_id, md5, crc32c) VALUES (?1, ?2, ?3, ?4)",
      [objectRef, assetId, hashes.md5, hashes.crc32c],
    );
  }

  async findCredential(id: CredentialId): Promise<CompatCredential | null> {
    const row = await queryFirst(this.db, `SELECT ${CREDENTIAL_COLUMNS} FROM compat_credentials WHERE id = ?1`, [id]);
    return row ? parseCredential(row) : null;
  }

  async findCredentialByEmail(clientEmail: string): Promise<CompatCredential | null> {
    const row = await queryFirst(
      this.db,
      `SELECT ${CREDENTIAL_COLUMNS} FROM compat_credentials WHERE client_email = ?1`,
      [clientEmail],
    );
    return row ? parseCredential(row) : null;
  }

  async insertCredential(c: CompatCredential): Promise<void> {
    await this.db.execute(
      `INSERT INTO compat_credentials (${CREDENTIAL_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [
        c.id, c.projectId, c.bucket, c.role, c.clientEmail, JSON.stringify(c.publicJwk),
        c.label, c.createdBy, c.createdAt, c.revokedAt,
      ],
    );
  }

  async listCredentials(projectId: string): Promise<CompatCredential[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${CREDENTIAL_COLUMNS} FROM compat_credentials WHERE project_id = ?1 ORDER BY created_at ASC, id ASC`,
      [projectId],
    );
    return rows.map(parseCredential);
  }

  async revokeCredential(projectId: string, id: CredentialId, at: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE compat_credentials SET revoked_at = COALESCE(revoked_at, ?3) WHERE id = ?2 AND project_id = ?1",
      [projectId, id, at],
    );
    return result.rowsAffected > 0;
  }

  async createUpload(u: UploadSession): Promise<void> {
    await this.db.execute(
      `INSERT INTO compat_uploads (${UPLOAD_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [u.id, u.bucket, u.key, u.credentialId, JSON.stringify(u.meta), u.received, u.hashState, u.state, u.result, u.expiresAt],
    );
  }

  async findUpload(id: UploadId): Promise<UploadSession | null> {
    const row = await queryFirst(this.db, `SELECT ${UPLOAD_COLUMNS} FROM compat_uploads WHERE id = ?1`, [id]);
    return row ? parseUpload(row) : null;
  }

  async advanceUpload(
    id: UploadId,
    expect: Pick<UploadSession, "received" | "state">,
    next: Pick<UploadSession, "received" | "hashState" | "state" | "result">,
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE compat_uploads SET received = ?4, hash_state = ?5, state = ?6, result = ?7
         WHERE id = ?1 AND received = ?2 AND state = ?3`,
      [id, expect.received, expect.state, next.received, next.hashState, next.state, next.result],
    );
    return result.rowsAffected > 0;
  }

  async listExpiredUploads(now: number, limit: number): Promise<UploadSession[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${UPLOAD_COLUMNS} FROM compat_uploads WHERE expires_at < ?1 ORDER BY expires_at ASC LIMIT ?2`,
      [now, limit],
    );
    return rows.map(parseUpload);
  }

  async deleteUpload(id: UploadId): Promise<void> {
    await this.db.execute("DELETE FROM compat_uploads WHERE id = ?1", [id]);
  }
}

/** Runs inside `SqlAtomicWrites.deleteAsset`'s batch, so the rows go only if the asset row goes too. */
export function compatDeleteByAsset(assetId: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM compat_bindings WHERE asset_id = ?1", args: [assetId] },
    { sql: "DELETE FROM compat_hashes WHERE asset_id = ?1", args: [assetId] },
  ];
}

function parseBucket(row: Row): CompatBucket {
  return {
    name: row.name as BucketName,
    projectId: row.project_id as string,
    mount: row.mount_rule ? JSON.parse(row.mount_rule as string) : null,
    createdAt: row.created_at as number,
  };
}

function parseBinding(row: Row): Binding {
  const common = { bucket: row.bucket as BucketName, assetId: row.asset_id as string };
  return row.binding === "folder"
    ? { kind: "folder", key: row.key as Extract<Binding, { kind: "folder" }>["key"], ...common }
    : { kind: "object", key: row.key as Extract<Binding, { kind: "object" }>["key"], ...common };
}

function parseCredential(row: Row): CompatCredential {
  return {
    id: row.id as CredentialId,
    projectId: row.project_id as string,
    bucket: row.bucket as BucketName,
    role: row.role as CompatCredential["role"],
    clientEmail: row.client_email as string,
    publicJwk: JSON.parse(row.public_jwk as string),
    label: (row.label as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    revokedAt: (row.revoked_at as number | null) ?? null,
  };
}

function parseUpload(row: Row): UploadSession {
  return {
    id: row.id as UploadId,
    bucket: row.bucket as BucketName,
    key: row.key as UploadSession["key"],
    credentialId: row.credential_id as CredentialId,
    meta: JSON.parse(row.meta as string),
    received: row.received as number,
    hashState: row.hash_state as string,
    state: row.state as UploadSession["state"],
    result: (row.result as string | null) ?? null,
    expiresAt: row.expires_at as number,
  };
}

/** node:sqlite returns a BLOB as a Uint8Array, D1 as an array of numbers. */
function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : Uint8Array.from(value as number[]);
}
