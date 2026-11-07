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
export const jobTypeSchema = z.literal("archive-extraction");
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
  userMeta: z.record(z.string(), z.unknown()).optional(),
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
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  activeVersionId: z.string().optional(),
  description: z.string().optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  currentVersion: assetVersionSchema.optional(),
  versionCount: z.number().optional(),
}));

export const assetUploadResultSchema = component("AssetUploadResponse", z.object({
  asset: assetMetadataSchema,
  url: z.string(),
}));

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
}));

export const completeUploadBodySchema = component("CompleteUploadSessionRequest", z.object({
  parts: z.array(uploadPartSchema).optional(),
}));

export const updateJobStatusBodySchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  error: z.string().optional(),
});

// --- Asset update ---

export const updateAssetBodySchema = component("UpdateAssetRequest", z.object({
  description: z.string().optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  activeVersionId: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
}));

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
export type AssetType = z.infer<typeof assetTypeSchema>;
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
export type UpdateVersionBody = z.infer<typeof updateVersionBodySchema>;
export type SetActiveVersionBody = z.infer<typeof setActiveVersionBodySchema>;
