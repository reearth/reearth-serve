import type {
  Binding, BindingKind, BucketName, CompatBucket, CompatCredential, CredentialId, ObjectInfo,
  UploadId, UploadPhase, UploadSession,
} from "../../core/compat/model";
import { base64Of, fromBase64 } from "../../core/compat/hash";
import {
  generationSeed, newClaimToken, type BindingKey, type ClaimResult, type ClaimToken, type CompatPublish, type CompatStore,
  type DeleteBucketResult, type LeaseToken, type RecordRef, type VersionRecord,
} from "../../core/compat/repository";
import type { Row, SqlClient, SqlStatement, SqlValue } from "../../core/sql/port";
import { queryAll, queryFirst } from "./helpers";
import { isServiceRole } from "../../core/auth/types";

const BUCKET_COLUMNS = "name, project_id, mount_rule, created_at";
const BINDING_COLUMNS = "bucket, key, binding, asset_id";
const CREDENTIAL_COLUMNS =
  "id, project_id, bucket, role, client_email, public_jwk, label, created_by, created_at, revoked_at";
const UPLOAD_COLUMNS = "id, bucket, key, credential_id, meta, expires_at, revision, phase";

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
      `INSERT OR IGNORE INTO compat_buckets (${BUCKET_COLUMNS}, last_generation) VALUES (?1, ?2, ?3, ?4, ?5)`,
      [bucket.name, bucket.projectId, bucket.mount ? JSON.stringify(bucket.mount) : null, bucket.createdAt, generationSeed()],
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

  async deleteProject(projectId: string): Promise<void> {
    const ofProject = "bucket IN (SELECT name FROM compat_buckets WHERE project_id = ?1)";
    await this.db.batch([
      { sql: `DELETE FROM compat_bindings WHERE ${ofProject}`, args: [projectId] },
      { sql: `DELETE FROM compat_uploads WHERE ${ofProject}`, args: [projectId] },
      { sql: "DELETE FROM compat_credentials WHERE project_id = ?1", args: [projectId] },
      { sql: "DELETE FROM compat_buckets WHERE project_id = ?1", args: [projectId] },
    ]);
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
    const token = newClaimToken();
    const claimed = await queryFirst(
      this.db,
      `INSERT INTO compat_bindings (bucket, key, binding, asset_id, claimed_at, claim_token) VALUES (?1, ?2, ?3, NULL, ?4, ?6)
         ON CONFLICT (bucket, key) DO UPDATE
           SET binding = excluded.binding, claimed_at = excluded.claimed_at, claim_token = excluded.claim_token
           WHERE compat_bindings.asset_id IS NULL AND compat_bindings.claimed_at < ?5
         RETURNING claim_token`,
      [bucket, key, kind, now, staleBefore, token],
    );
    if (claimed) return { kind: "claimed", token };
    const binding = await this.findBinding(bucket, key);
    return binding ? { kind: "bound", binding } : { kind: "busy" };
  }

  async bind(bucket: BucketName, key: BindingKey, token: ClaimToken, assetId: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE compat_bindings SET asset_id = ?4
         WHERE bucket = ?1 AND key = ?2 AND ((asset_id IS NULL AND claim_token = ?3) OR asset_id = ?4)`,
      [bucket, key, token, assetId],
    );
    return result.rowsAffected > 0;
  }

  async releaseClaim(bucket: BucketName, key: BindingKey, token: ClaimToken): Promise<void> {
    await this.db.execute(
      "DELETE FROM compat_bindings WHERE bucket = ?1 AND key = ?2 AND asset_id IS NULL AND claim_token = ?3",
      [bucket, key, token],
    );
  }

  async deleteBinding(bucket: BucketName, key: BindingKey): Promise<void> {
    await this.db.execute("DELETE FROM compat_bindings WHERE bucket = ?1 AND key = ?2", [bucket, key]);
  }

  async lease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number, staleBefore: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE compat_bindings SET lease_token = ?3, leased_at = ?4
         WHERE bucket = ?1 AND key = ?2 AND asset_id IS NOT NULL AND (lease_token IS NULL OR leased_at < ?5)`,
      [bucket, key, token, now, staleBefore],
    );
    return result.rowsAffected > 0;
  }

  async renewLease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE compat_bindings SET leased_at = ?4 WHERE bucket = ?1 AND key = ?2 AND lease_token = ?3",
      [bucket, key, token, now],
    );
    return result.rowsAffected > 0;
  }

  async renewClaim(bucket: BucketName, key: BindingKey, token: ClaimToken, now: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE compat_bindings SET claimed_at = ?4 WHERE bucket = ?1 AND key = ?2 AND asset_id IS NULL AND claim_token = ?3",
      [bucket, key, token, now],
    );
    return result.rowsAffected > 0;
  }

  async releaseLease(bucket: BucketName, key: BindingKey, token: LeaseToken): Promise<void> {
    await this.db.execute(
      "UPDATE compat_bindings SET lease_token = NULL, leased_at = NULL WHERE bucket = ?1 AND key = ?2 AND lease_token = ?3",
      [bucket, key, token],
    );
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

  async records(bucket: BucketName, refs: RecordRef[]): Promise<Map<string, VersionRecord>> {
    const unique = [...new Map(refs.map((r) => [r.objectRef, r])).values()];
    if (unique.length === 0) return new Map();
    const wanted = JSON.stringify(unique.map((r) => ({ ref: r.objectRef, asset: r.assetId })));
    const refIds = JSON.stringify(unique.map((r) => r.objectRef));
    const results = await this.db.batch([
      ...recordInVersionOrder(bucket, wanted),
      ...unique.flatMap((r) => r.hashes
        ? [{
          sql: "UPDATE compat_hashes SET md5 = ?2, crc32c = ?3 WHERE object_ref = ?1 AND md5 IS NULL",
          args: [r.objectRef, r.hashes.md5, r.hashes.crc32c],
        }]
        : []),
      {
        sql: `SELECT h.object_ref, h.generation, h.md5, h.crc32c FROM compat_hashes AS h
               WHERE h.object_ref IN (SELECT value FROM json_each(?2))
                 AND EXISTS (SELECT 1 FROM compat_buckets WHERE name = ?1)`,
        args: [bucket, refIds],
      },
    ]);
    return new Map(results[results.length - 1].rows.map((row) => [row.object_ref as string, {
      generation: Number(row.generation),
      hashes: hashesOf(row),
    }]));
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

  async insertCredential(c: CompatCredential): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT INTO compat_credentials (${CREDENTIAL_COLUMNS}) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE EXISTS (SELECT 1 FROM compat_buckets WHERE name = ?3 AND project_id = ?2)`,
      [
        c.id, c.projectId, c.bucket, c.role, c.clientEmail, JSON.stringify(c.publicJwk),
        c.label, c.createdBy, c.createdAt, c.revokedAt,
      ],
    );
    return result.rowsAffected > 0;
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
      `INSERT INTO compat_uploads (${UPLOAD_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      [u.id, u.bucket, u.key, u.credentialId, JSON.stringify(u.meta), u.expiresAt, u.revision, encodePhase(u.phase)],
    );
  }

  async findUpload(id: UploadId): Promise<UploadSession | null> {
    const row = await queryFirst(this.db, `SELECT ${UPLOAD_COLUMNS} FROM compat_uploads WHERE id = ?1`, [id]);
    return row ? parseUpload(row) : null;
  }

  async updateUpload(id: UploadId, revision: number, phase: UploadPhase): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE compat_uploads SET phase = ?3, revision = ?2 + 1 WHERE id = ?1 AND revision = ?2",
      [id, revision, encodePhase(phase)],
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

  async deleteUpload(id: UploadId, revision?: number): Promise<boolean> {
    const result = revision === undefined
      ? await this.db.execute("DELETE FROM compat_uploads WHERE id = ?1", [id])
      : await this.db.execute("DELETE FROM compat_uploads WHERE id = ?1 AND revision = ?2", [id, revision]);
    return result.rowsAffected > 0;
  }

  async sweepStaleHolds(staleBefore: number): Promise<{ claims: number; leases: number }> {
    const [claims, leases] = await this.db.batch([
      { sql: "DELETE FROM compat_bindings WHERE asset_id IS NULL AND claimed_at < ?1", args: [staleBefore] },
      {
        sql: "UPDATE compat_bindings SET lease_token = NULL, leased_at = NULL WHERE lease_token IS NOT NULL AND leased_at < ?1",
        args: [staleBefore],
      },
    ]);
    return { claims: claims.rowsAffected, leases: leases.rowsAffected };
  }
}

/**
 * The condition under which `publish` applies, with its parameters numbered
 * from `firstParam`. A claim stays held after the publish's own statement
 * fills it with `assetId`, so every statement of the publish sees one answer.
 */
export function compatHolds(publish: CompatPublish, firstParam: number): { sql: string; args: SqlValue[] } {
  const [id, revision, bucket, key, token, assetId] = [0, 1, 2, 3, 4, 5].map((i) => `?${firstParam + i}`);
  const binding = publish.hold.kind === "lease"
    ? `lease_token = ${token} AND asset_id = ${assetId}`
    : `claim_token = ${token} AND (asset_id IS NULL OR asset_id = ${assetId})`;
  const { hold, upload } = publish;
  return {
    sql: `EXISTS (SELECT 1 FROM compat_uploads WHERE id = ${id} AND revision = ${revision})
      AND EXISTS (SELECT 1 FROM compat_bindings WHERE bucket = ${bucket} AND key = ${key} AND ${binding})`,
    args: [upload.id, upload.revision, hold.bucket, hold.key, hold.token, hold.assetId],
  };
}

/**
 * The statements after the row inserts that publish a resumable commit
 * (ADR-019 §3), each under `compatHolds`. The session moves last, so the
 * revision the others check is still the one the commit owns. `generationAt`
 * is the statement whose `last_generation` row is the issued generation. The
 * new row is the newest version of its asset, so it is recorded after every
 * older unrecorded version, at the top of the bucket's high mark.
 */
export function compatPublish(publish: CompatPublish): { statements: SqlStatement[]; generationAt: number } {
  const { hold, record, upload } = publish;
  const at = (sql: string, args: SqlValue[], returning = ""): SqlStatement => {
    const holds = compatHolds(publish, args.length + 1);
    return { sql: `${sql} AND ${holds.sql}${returning}`, args: [...args, ...holds.args] };
  };
  const high = "(SELECT last_generation FROM compat_buckets WHERE name = ?1)";
  const live = hold.kind === "lease"
    ? at("UPDATE assets SET active_version_id = NULL WHERE id = ?1", [hold.assetId])
    : at("UPDATE compat_bindings SET asset_id = ?4 WHERE bucket = ?1 AND key = ?2 AND claim_token = ?3 AND asset_id IS NULL",
      [hold.bucket, hold.key, hold.token, hold.assetId]);
  const committed = encodePhase({ state: "committed", result: { ...publish.result, generation: 0 } });
  const [recordOlder, raise] = recordInVersionOrder(
    hold.bucket, JSON.stringify([{ ref: record.objectRef, asset: hold.assetId }]), compatHolds(publish, 3),
  );
  return {
    statements: [
      live,
      recordOlder,
      { ...raise, sql: `${raise.sql} RETURNING last_generation` },
      at("UPDATE compat_hashes SET md5 = ?2, crc32c = ?3 WHERE object_ref = ?1", [record.objectRef, record.hashes.md5, record.hashes.crc32c]),
      ...publish.reclaim.map((prefix) =>
        at("INSERT OR REPLACE INTO cleanup_pending (prefix, created_at) SELECT ?1, ?2 WHERE 1", [prefix, Date.now()])),
      at(
        `UPDATE compat_uploads SET phase = json_set(?2, '$.result.generation', ${high}), revision = revision + 1
           WHERE id = ?3`,
        [hold.bucket, committed, upload.id],
      ),
    ],
    generationAt: 2,
  };
}

/**
 * Store a record at the bucket's next generations for each wanted ref with
 * none, after its asset row and every older version of its asset, oldest
 * first, then raise the high mark past them. The raise writes no row when no
 * record was new. `wanted` is a JSON array of `{ ref, asset }` bound as ?2;
 * ?1 is the bucket. Both statements apply only under `guard`, whose
 * parameters are numbered from ?3.
 */
export function recordInVersionOrder(
  bucket: BucketName, wanted: string, guard: { sql: string; args: SqlValue[] } = { sql: "1", args: [] },
): SqlStatement[] {
  return [
    {
      sql: `WITH wanted AS (
              SELECT json_extract(w.value, '$.ref') AS ref, json_extract(w.value, '$.asset') AS asset, v.version AS version
                FROM json_each(?2) AS w
                LEFT JOIN asset_versions AS v ON v.id = json_extract(w.value, '$.ref') AND v.asset_id = json_extract(w.value, '$.asset')
            ),
            due (ref, asset, version) AS (
              SELECT ref, asset, COALESCE(version, 0) FROM wanted
              UNION SELECT asset, asset, 0 FROM wanted WHERE version IS NOT NULL
              UNION SELECT o.id, o.asset_id, o.version FROM wanted AS w JOIN asset_versions AS o ON o.asset_id = w.asset AND o.version < w.version
            )
            INSERT INTO compat_hashes (object_ref, asset_id, generation, md5, crc32c)
              SELECT d.ref, d.asset, b.last_generation + ROW_NUMBER() OVER (ORDER BY d.asset, d.version), NULL, NULL
                FROM due AS d JOIN compat_buckets AS b ON b.name = ?1
               WHERE NOT EXISTS (SELECT 1 FROM compat_hashes AS h WHERE h.object_ref = d.ref) AND ${guard.sql}
            ON CONFLICT (object_ref) DO NOTHING`,
      args: [bucket, wanted, ...guard.args],
    },
    {
      sql: `UPDATE compat_buckets SET last_generation = m.top
              FROM (SELECT MAX(generation) AS top FROM compat_hashes
                     WHERE asset_id IN (SELECT json_extract(value, '$.asset') FROM json_each(?2))) AS m
             WHERE name = ?1 AND m.top > last_generation AND ${guard.sql}`,
      args: [bucket, wanted, ...guard.args],
    },
  ];
}

/** Runs inside `SqlAtomicWrites.deleteAsset`'s batch, so the rows go only if the asset row goes too. */
export function compatDeleteByAsset(assetId: string): SqlStatement[] {
  return [
    { sql: "DELETE FROM compat_bindings WHERE asset_id = ?1", args: [assetId] },
    { sql: "DELETE FROM compat_hashes WHERE asset_id = ?1", args: [assetId] },
  ];
}

function hashesOf(row: Row): VersionRecord["hashes"] {
  return row.md5 === null ? null : { md5: toBytes(row.md5), crc32c: Number(row.crc32c) };
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
  const role = String(row.role);
  if (!isServiceRole(role)) throw new Error(`compat credential ${String(row.id)} has role ${role}`);
  return {
    id: row.id as CredentialId,
    projectId: row.project_id as string,
    bucket: row.bucket as BucketName,
    role,
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
    expiresAt: row.expires_at as number,
    revision: row.revision as number,
    phase: decodePhase(row.phase as string),
  };
}

type StoredInfo = Omit<ObjectInfo, "created" | "updated" | "hashes"> & {
  created: number; updated: number; hashes: { md5: string; crc32c: number } | null;
};

type StoredPhase = Exclude<UploadPhase, { state: "committed" }> | { state: "committed"; result: StoredInfo };

function encodePhase(phase: UploadPhase): string {
  if (phase.state !== "committed") return JSON.stringify(phase);
  const info = phase.result;
  const result: StoredInfo = {
    ...info,
    created: info.created.getTime(),
    updated: info.updated.getTime(),
    hashes: info.hashes && { md5: base64Of(info.hashes.md5), crc32c: info.hashes.crc32c },
  };
  return JSON.stringify({ state: "committed", result } satisfies StoredPhase);
}

function decodePhase(text: string): UploadPhase {
  const stored = JSON.parse(text) as StoredPhase;
  if (stored.state !== "committed") return stored;
  const { result } = stored;
  return {
    state: "committed",
    result: {
      ...result,
      created: new Date(result.created),
      updated: new Date(result.updated),
      hashes: result.hashes && { md5: fromBase64(result.hashes.md5), crc32c: result.hashes.crc32c },
    },
  };
}

/** node:sqlite returns a BLOB as a Uint8Array, D1 as an array of numbers. */
function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : Uint8Array.from(value as number[]);
}
