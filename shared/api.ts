import { z } from "zod";

// --- Filename ---

// A filename becomes the last segment of an object key (`assets/<id>/<name>`).
// Separators or dot segments would let it address another asset's key, since
// URL resolution collapses `../` before a presigned URL is signed.
export function isSafeFilename(name: string): boolean {
  return name.length > 0 && name.length <= 255 &&
    name !== "." && name !== ".." &&
    !/[/\\\u0000-\u001f\u007f]/.test(name);
}

export const filenameSchema = z.string().refine(isSafeFilename, "Invalid filename");

// --- OpenAPI component names ---
//
// `component()` tags a schema with `.meta({ ref })`, which makes hono-openapi
// emit it as a named entry in `components.schemas` and `$ref` it, so generated
// clients (e.g. oapi-codegen in an external client) get `Asset` instead of
// `PostApiV1Assets201JSONResponseBodyAsset`. The ref is not inherited by
// `.extend()`, so derived shapes stay inline.
//
// It also records the schema in `openApiComponentSchemas`. core/openapi.ts builds
// `components.schemas` from that list rather than relying on hono-openapi to
// collect them from the routes: hono-openapi resolves route schemas in place,
// so a route that was already resolved (e.g. a module Vite did not reload)
// contributes its $refs but no components.

export const openApiComponentSchemas: z.ZodType[] = [];

export function component<T extends z.ZodType>(ref: string, schema: T, meta: Record<string, unknown> = {}): T {
  const named = schema.meta({ ...meta, ref });
  openApiComponentSchemas.push(named);
  return named;
}

/**
 * A named string enum. `x-enum-varnames` prefixes each Go constant with the
 * type name (`RoleOwner`, `ArchiveFormatTarGz`); oapi-codegen otherwise emits
 * bare `Owner` / `Pending` constants unless two enums happen to collide.
 */
function enumComponent<T extends z.ZodEnum>(ref: string, schema: T): T {
  const varnames = schema.options.map((value) =>
    ref + String(value).split(/[^A-Za-z0-9]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(""),
  );
  return component(ref, schema, { "x-enum-varnames": varnames });
}

// --- Enums ---

export const assetTypeSchema = enumComponent("AssetType", z.enum(["file", "archive"]));
export const assetStatusSchema = enumComponent("AssetStatus", z.enum(["pending", "ready", "extracting", "failed"]));
export const archiveFormatSchema = enumComponent("ArchiveFormat", z.enum(["zip", "tar", "tar.gz", "tar.bz2"]));
/**
 * How an asset's files are guarded (ADR-013 B7, ADR-014 §1).
 *
 * ADR-013 B7 writes the field as `hosting.access`; ADR-014 §1 declares the flat
 * `access` field canonical and the two the same thing. The flat name is the one
 * implemented: protection is a property of the asset, not of hosting, and
 * ADR-014's `restricted` mode joins this enum without a shape change.
 */
export const assetAccessSchema = enumComponent("AssetAccess", z.enum(["public", "password"]));
/**
 * Whether a version's `sha256` has been confirmed over the stored bytes
 * (ADR-017 §1). Absent on versions stored before ADR-017.
 *
 * - `verified` — the store or Serve hashed the stored bytes and they match.
 * - `pending` — the bytes are in place and servable, the hash is not yet
 *   confirmed (presigned uploads the store did not vouch for; `sha256` is the
 *   declared hash, or absent when none was declared). An
 *   `integrity-verification` job settles it (ADR-017 §2).
 * - `failed` — a declared hash did not match. Reserved: such an upload is
 *   deleted outright, so no row is ever served with this value today.
 */
export const integritySchema = enumComponent("Integrity", z.enum(["verified", "pending", "failed"]));
/**
 * What a job does.
 *
 * - `archive-extraction` — unpacks an archive upload into its files (ADR-001).
 * - `integrity-verification` — streams a presigned upload once and confirms its
 *   SHA-256 (ADR-017 §2). Its failure class is "rejected version" (ADR-018
 *   §6): a mismatch deletes the upload, which is final and not retried.
 */
export const jobTypeSchema = enumComponent("JobType", z.enum(["archive-extraction", "integrity-verification"]));
export const jobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

// Upload request headers (`Content-Encoding`, `X-Skip-Extraction`). Named so
// the header parameters of both direct-upload routes share one type
// (oapi-codegen only reuses a parameter's type when its schema is a $ref).
export const contentEncodingHeaderSchema = enumComponent("ContentEncoding", z.enum(["gzip"]));
export const skipExtractionHeaderSchema = enumComponent("XSkipExtraction", z.enum(["true"]));

// --- Role ---

export const roleSchema = enumComponent("Role", z.enum(["owner", "admin", "editor", "viewer"]));

// --- Workspace ---

export const workspaceSchema = component("Workspace", z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
}));

export const createWorkspaceBodySchema = component("CreateWorkspaceRequest", z.object({
  name: z.string().min(1).max(100),
}));

// --- Member ---

export const memberSchema = component("Member", z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: roleSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}));

export const addMemberBodySchema = component("AddMemberRequest", z.object({
  userId: z.string(),
  role: roleSchema,
}));

export const updateMemberBodySchema = component("UpdateMemberRoleRequest", z.object({
  role: roleSchema,
}));

// --- Project ---

export const projectSchema = component("Project", z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  ownerId: z.string(),
  workspaceId: z.string().optional(),
}));

export const createProjectBodySchema = component("CreateProjectRequest", z.object({
  name: z.string().min(1).max(100),
  workspaceId: z.string().optional(),
}));

// --- Site hosting rules (ADR-013 C3) ---

/**
 * One block of `_headers`: a path pattern and the headers it adds. Header
 * names are lowercased at parse time; values are verbatim.
 */
export const siteHeaderRuleSchema = z.object({
  pattern: z.string(),
  headers: z.record(z.string(), z.string()),
});

/** One line of `_redirects`. `status` 200 is a rewrite, not a redirect. */
export const siteRedirectRuleSchema = z.object({
  from: z.string(),
  to: z.string(),
  status: z.number(),
  /** `!` in the file: apply even when `from` exists as a file. */
  force: z.boolean(),
});

/**
 * The parsed contents of an archive's `_headers` and `_redirects`, stored as
 * system metadata on the version the extraction produced (ADR-013 C3).
 *
 * System metadata, never `userMeta`: a caller that PATCHed its own metadata
 * would otherwise silently delete the site's routing. `warnings` is why a rule
 * the author wrote is not in the list, and is the whole reason this is visible
 * in the API at all.
 */
export const siteHostingSchema = z.object({
  headers: z.array(siteHeaderRuleSchema),
  redirects: z.array(siteRedirectRuleSchema),
  warnings: z.array(z.string()),
});

// --- Asset ---

export const assetVersionSchema = component("AssetVersion", z.object({
  id: z.string(),
  assetId: z.string(),
  version: z.number(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  createdAt: z.number(),
  contentEncoding: z.string().optional(),
  originalSize: z.number().optional(),
  type: assetTypeSchema.optional(),
  status: assetStatusSchema.optional(),
  archiveFormat: archiveFormatSchema.optional(),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  jobId: z.string().optional(),
  /**
   * SHA-256 of the stored bytes, lowercase hex (ADR-017 §1) — after the
   * client's gzip when the object is stored gzip. Absent on objects stored
   * before ADR-017.
   */
  sha256: z.string().optional(),
  integrity: integritySchema.optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  /**
   * `_headers` / `_redirects` as parsed at extraction time (ADR-013 C3).
   * Read-only system metadata — it lives in the version's `meta` column, which
   * is exactly what ADR-005's system/user split reserves for fields serve owns.
   */
  hosting: siteHostingSchema.optional(),
}));

export const assetMetadataSchema = component("Asset", z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  createdAt: z.number(),
  expiresAt: z.number(),
  contentEncoding: z.string().optional(),
  originalSize: z.number().optional(),
  type: assetTypeSchema.optional(),
  status: assetStatusSchema.optional(),
  archiveFormat: archiveFormatSchema.optional(),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  jobId: z.string().optional(),
  /**
   * SHA-256 of the stored bytes, lowercase hex (ADR-017 §1) — after the
   * client's gzip when the object is stored gzip. Absent on objects stored
   * before ADR-017. On the asset it describes the first upload, which has
   * no version row; each version carries its own.
   */
  sha256: z.string().optional(),
  integrity: integritySchema.optional(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  activeVersionId: z.string().optional(),
  description: z.string().optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  currentVersion: assetVersionSchema.optional(),
  versionCount: z.number().optional(),
  /**
   * Access mode (ADR-013 B7). Visible to the caller because it changes how the
   * asset is consumed — a protected asset needs a credentialed fetch. The
   * password hash, its salt and its version are never exposed.
   */
  access: assetAccessSchema.optional(),
  /**
   * SPA fallback (ADR-013 C1). When true, a miss inside the extracted archive
   * that does not look like a request for an asset file is answered with the
   * root `index.html` at status 200. Off by default — a tile viewer needs its
   * 404s.
   *
   * A flat system field, like `access`: ADR-013 C1 proposed
   * `userMeta.hosting.spa`, but `userMeta` is caller-owned and a client that
   * PATCHes the whole object would silently turn the flag off.
   */
  spa: z.boolean().optional(),
  /**
   * `_headers` / `_redirects` for an archive that has no version row
   * (ADR-013 C3). A first upload creates only the asset — versions start at the
   * second — so the rules of a one-version site have nowhere else to live. When
   * a version does carry them, the version's win.
   */
  hosting: siteHostingSchema.optional(),
}));

export const assetUploadResultSchema = component("AssetUploadResponse", z.object({
  asset: assetMetadataSchema,
  url: z.string(),
  // Site host of an archive asset (ADR-013 B1). Present only when the
  // deployment has SITE_HOST_SUFFIX configured and the asset is an archive.
  siteUrl: z.string().optional(),
}));

// --- Site hosts (ADR-013 B2) ---

export const siteHostKindSchema = enumComponent("SiteHostKind", z.enum(["subdomain", "custom"]));

/** Whether a custom domain is serving TLS yet (ADR-013 B5). */
export const certificateStatusSchema = z.enum(["pending", "active"]);

/**
 * A row of `site_hosts` as the API shows it: the columns a caller can act on,
 * plus the URL the site is served from. `createdBy` and the verification token
 * stay internal — the token is only ever handed back inside the `verification`
 * instructions of the row's own responses.
 */
export const siteHostSchema = component("SiteHost", z.object({
  hostname: z.string(),
  /** Null once the name has been released and is living out its cooldown. */
  assetId: z.string().nullable(),
  projectId: z.string(),
  kind: siteHostKindSchema,
  /** Whether `v{n}--` / `latest--` hosts resolve (ADR-013 B4). */
  previews: z.boolean(),
  /**
   * When the TXT check passed (ADR-013 B5). Always null on `subdomain` rows —
   * there is nothing to verify about a name under our own suffix — and null on
   * a `custom` row that does not resolve yet.
   */
  verifiedAt: z.number().nullable().optional(),
  /** The provisioner's last word on the certificate (ADR-013 B5). */
  certificateStatus: z.string().nullable().optional(),
  disabledAt: z.number().nullable().optional(),
  releasedAt: z.number().nullable().optional(),
  createdAt: z.number(),
  url: z.string(),
}));

/**
 * What a customer must publish for a custom domain (ADR-013 B5): one TXT
 * record proving they own it, and the CNAME that points it at us. Returned
 * with the row while it is unverified, and by the claim itself.
 */
export const siteHostVerificationSchema = z.object({
  verification: z.object({
    /** `_reearth-serve-verify.<hostname>` */
    record: z.string(),
    type: z.literal("TXT"),
    /** `reearth-serve-verify=<token>` */
    value: z.string(),
  }),
  cname: z.object({ target: z.string() }),
});

export const claimSiteHostBodySchema = component("ClaimSiteHostRequest", z.object({
  /**
   * For `subdomain`: the bare label (`kawasaki-flood-map`) or the full host.
   * For `custom`: the whole hostname the customer owns (`map.city.example.jp`).
   */
  hostname: z.string(),
  kind: siteHostKindSchema.optional(),
}));

/**
 * `PATCH …/hosts/:hostname` (ADR-013 B6): the two switches a claimed name has.
 *
 * - `disabled` — B3's publish state. True takes the site down (`503`, name
 *   held); false brings it back.
 * - `previews` — B4's `v{n}--` / `latest--` hosts, off by default.
 *
 * Both are optional, but an empty body is a no-op the caller did not mean, so
 * at least one must be present.
 */
export const updateSiteHostBodySchema = component("UpdateSiteHostRequest", z.object({
  disabled: z.boolean().optional(),
  previews: z.boolean().optional(),
}).refine(
  (body) => body.disabled !== undefined || body.previews !== undefined,
  { message: "at least one of disabled or previews is required" },
));

// --- Upload session ---

export const presignedUploadResultSchema = component("PresignedUploadSession", z.object({
  uploadId: z.string(),
  url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  contentEncoding: z.string().optional(),
  expiresAt: z.number(),
}));

/** One presigned URL per part; the client PUTs part `partNumber` to `url`. */
export const multipartUploadPartSchema = component("MultipartUploadPart", z.object({
  partNumber: z.number(),
  url: z.string(),
}));

export const multipartUploadResultSchema = component("MultipartUploadSession", z.object({
  uploadId: z.string(),
  parts: z.array(multipartUploadPartSchema),
  contentEncoding: z.string().optional(),
  expiresAt: z.number(),
}));

export const uploadPartSchema = component("UploadPart", z.object({
  partNumber: z.number(),
  etag: z.string(),
}));

// --- Job ---

export const jobSchema = component("Job", z.object({
  id: z.string(),
  assetId: z.string(),
  type: jobTypeSchema,
  status: jobStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  startedAt: z.number().optional(),
  error: z.string().optional(),
  totalFiles: z.number().optional(),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  retryCount: z.number().optional(),
  // Progress markers captured at the last re-enqueue. The cleanup cron resets
  // retryCount when fileCount/extractedSize moved past these, so the retry
  // budget counts "died at the same point" repetitions rather than container
  // deaths (deploy rollouts would otherwise exhaust it on long extractions).
  retryFileCount: z.number().optional(),
  retryExtractedSize: z.number().optional(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  versionId: z.string().optional(),
}));

// --- File entry (archive manifest) ---

export const fileEntrySchema = component("FileEntry", z.object({
  path: z.string(),
  size: z.number(),
  contentType: z.string(),
  contentEncoding: z.string().optional(),
  hash: z.string().optional(),
}));

// --- Request bodies ---

// S3 multipart upload allows at most 10000 parts; bound partCount to prevent
// client-side abuse (each part triggers an HMAC-SHA256 signature on the Worker).
export const MAX_UPLOAD_PARTS = 10000;

export const createUploadSessionBodySchema = component("CreateUploadSessionRequest", z.object({
  filename: filenameSchema,
  contentType: z.string().optional(),
  size: z.number(),
  partCount: z.number().int().positive().max(MAX_UPLOAD_PARTS).optional(),
  /**
   * Declared SHA-256 of the bytes that will be uploaded, hex (ADR-017 §1) —
   * of the stored bytes, i.e. after gzip when the session answers
   * `contentEncoding: gzip`. On a single-PUT session it is signed into the URL
   * as `x-amz-checksum-sha256`, which the client must send (see the response's
   * `headers`).
   */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "sha256 must be 64 hex characters").optional(),
}));

export const completeUploadBodySchema = component("CompleteUploadSessionRequest", z.object({
  parts: z.array(uploadPartSchema).optional(),
}));

export const updateJobStatusBodySchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  error: z.string().optional(),
  /** `integrity-verification` jobs: the SHA-256 the verifier computed, sent with `completed`. */
  sha256: z.string().optional(),
});

// --- Asset update ---

/** ADR-013 B7: the bounds a shared site password must fall within. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const updateAssetBodySchema = component("UpdateAssetRequest", z.object({
  description: z.string().optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  activeVersionId: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
  /**
   * Turn protection on or off (ADR-013 B7). `password` requires `password`;
   * `public` forbids it, so "unprotect" cannot be typed as an accidental
   * password change. Re-sending `password` with a new secret rotates it and
   * bumps the version, which invalidates every outstanding cookie.
   */
  access: assetAccessSchema.optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
  /**
   * Turn the SPA fallback on or off (ADR-013 C1). Site (archive) assets in a
   * project only; turning it off is always allowed.
   */
  spa: z.boolean().optional(),
}).refine(
  (body) => body.access !== "password" || body.password !== undefined,
  { message: "access \"password\" requires a password", path: ["password"] },
).refine(
  (body) => body.password === undefined || body.access === "password",
  { message: "password is only accepted with access \"password\"", path: ["password"] },
));

// --- Version update ---

export const updateVersionBodySchema = component("UpdateVersionRequest", z.object({
  userMeta: z.record(z.string(), z.unknown()).optional(),
}));

// --- Set active version ---

export const setActiveVersionBodySchema = component("SetActiveVersionRequest", z.object({
  versionId: z.string().nullable(),
}));

// --- Error response ---

export const errorResponseSchema = component("Error", z.object({
  error: z.string(),
}));

// --- Inferred types ---

export type Role = z.infer<typeof roleSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBodySchema>;
export type Member = z.infer<typeof memberSchema>;
export type AddMemberBody = z.infer<typeof addMemberBodySchema>;
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type AssetAccess = z.infer<typeof assetAccessSchema>;
export type SiteHeaderRule = z.infer<typeof siteHeaderRuleSchema>;
export type SiteRedirectRule = z.infer<typeof siteRedirectRuleSchema>;
export type SiteHosting = z.infer<typeof siteHostingSchema>;
export type AssetType = z.infer<typeof assetTypeSchema>;
export type Integrity = z.infer<typeof integritySchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;
export type AssetVersion = z.infer<typeof assetVersionSchema>;
export type AssetMetadata = z.infer<typeof assetMetadataSchema>;
export type AssetUploadResult = z.infer<typeof assetUploadResultSchema>;
export type PresignedUploadResult = z.infer<typeof presignedUploadResultSchema>;
export type MultipartUploadResult = z.infer<typeof multipartUploadResultSchema>;
export type UploadPart = z.infer<typeof uploadPartSchema>;
export type Job = z.infer<typeof jobSchema>;
export type CreateUploadSessionBody = z.infer<typeof createUploadSessionBodySchema>;
export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;
export type UpdateJobStatusBody = z.infer<typeof updateJobStatusBodySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type UpdateAssetBody = z.infer<typeof updateAssetBodySchema>;
export type SiteHostKind = z.infer<typeof siteHostKindSchema>;
export type SiteHost = z.infer<typeof siteHostSchema>;
export type CertificateStatus = z.infer<typeof certificateStatusSchema>;
export type SiteHostVerification = z.infer<typeof siteHostVerificationSchema>;
export type ClaimSiteHostBody = z.infer<typeof claimSiteHostBodySchema>;
export type UpdateSiteHostBody = z.infer<typeof updateSiteHostBodySchema>;
export type UpdateVersionBody = z.infer<typeof updateVersionBodySchema>;
export type SetActiveVersionBody = z.infer<typeof setActiveVersionBodySchema>;
