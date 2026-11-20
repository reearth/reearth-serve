import type { z } from "zod";
import type { ServicePrincipal, ServiceRole } from "../auth/types";
import type { compatMountRuleSchema } from "../../shared/compat";
import type { HashState } from "./hash";

export type BucketName = string & { readonly __brand: "BucketName" };
/** A decoded object key. May contain '/' and end with it. */
export type ObjectKey = string & { readonly __brand: "ObjectKey" };
/** A folder path produced by a MountRule. Always ends in '/'. */
export type FolderKey = string & { readonly __brand: "FolderKey" };
export type CredentialId = string & { readonly __brand: "CredentialId" };
export type UploadId = string & { readonly __brand: "UploadId" };

/**
 * GCS bucket naming: 3 to 63 characters of lowercase letters, digits, '-', '_'
 * and '.', starting and ending with a letter or digit, never shaped like an
 * IPv4 address and never starting with "goog".
 */
export function parseBucketName(raw: string): BucketName | null {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(raw)) return null;
  if (raw.includes("..") || raw.startsWith("goog") || /^\d+\.\d+\.\d+\.\d+$/.test(raw)) return null;
  return raw as BucketName;
}

export type MountRule = z.infer<typeof compatMountRuleSchema>;
/** "none": entry path is the path inside the archive. "skip-top": drop a top folder named like the archive. */
export type StripRule = MountRule["strip"];

export type CompatBucket = {
  name: BucketName;
  projectId: string;
  mount: MountRule | null;
  createdAt: number;
};

export type BindingKind = "object" | "folder";

export type Binding =
  | { kind: "object"; bucket: BucketName; key: ObjectKey; assetId: string }
  | { kind: "folder"; bucket: BucketName; key: FolderKey; assetId: string };

export type ExactHashes = { md5: Uint8Array; crc32c: number };

export type CompatCredential = {
  id: CredentialId;
  projectId: string;
  bucket: BucketName;
  role: ServiceRole;
  clientEmail: string;
  publicJwk: JsonWebKey;
  label: string | null;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
};

export function servicePrincipalOf(credential: CompatCredential): ServicePrincipal {
  const { id, projectId, bucket, role, revokedAt } = credential;
  return { kind: "service", id, grant: { projectId, bucket, role }, revokedAt };
}

export function parseCompatHost(value: string | undefined, setting = "COMPAT_GCS_HOST"): string | undefined {
  if (!value) return undefined;
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const match = new RegExp(`^${label}(?:\\.${label})*(?::(\\d{1,5}))?$`).exec(value);
  if (!match || Number(match[1] ?? 1) > 65535) {
    throw new Error(`${setting} "${value}" is not a bare host[:port] (lowercase, no scheme or path)`);
  }
  return value;
}

export type PutMeta = {
  contentType: string;
  contentEncoding: string | null;
  userMeta: Record<string, string>;
  /** ifGenerationMatch. 0 means "only if absent". */
  ifGenerationMatch: number | null;
};

export type StagedPart = { key: string; size: number };

export type CommitOwner = { token: string; since: number };

export type UploadPhase =
  | { state: "open"; received: number; total: number | null; hashState: HashState; parts: StagedPart[] }
  | {
    state: "committing";
    size: number;
    hashState: HashState;
    parts: StagedPart[];
    owner: CommitOwner | null;
    overwritingAssetId: string | null;
  }
  | { state: "committed"; result: ObjectInfo }
  | { state: "failed"; error: CompatError };

export type UploadSession = {
  id: UploadId;
  bucket: BucketName;
  key: ObjectKey;
  credentialId: CredentialId;
  meta: PutMeta;
  expiresAt: number;
  revision: number;
  phase: UploadPhase;
};

export type ObjectInfo = {
  bucket: BucketName;
  key: ObjectKey;
  size: number;
  contentType: string;
  contentEncoding: string | null;
  generation: number;
  metageneration: number;
  etag: string;
  created: Date;
  updated: Date;
  hashes: ExactHashes | null;
  userMeta: Record<string, string>;
};

export type SizedBody = {
  stream: ReadableStream<Uint8Array>;
  size: number;
  hashes?: ExactHashes;
};

export type CompatError =
  | { code: "no_such_bucket" }
  | { code: "no_such_key" }
  | { code: "no_such_upload" }
  | { code: "forbidden" }
  | { code: "precondition_failed" }
  | { code: "busy" }
  | { code: "invalid"; message: string }
  | { code: "too_large" }
  | { code: "not_implemented"; what: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: CompatError };

export function parseObjectKey(raw: string): ObjectKey | null {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes === 0 || bytes > 1024 || /[\r\n]/.test(raw) || raw === "." || raw === "..") return null;
  return raw as ObjectKey;
}
