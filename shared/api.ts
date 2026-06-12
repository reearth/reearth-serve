import { z } from "zod";

// --- Enums ---

export const assetTypeSchema = z.enum(["file", "archive"]);
export const assetStatusSchema = z.enum(["pending", "ready", "extracting", "failed"]);
export const archiveFormatSchema = z.enum(["zip", "tar", "tar.gz", "tar.bz2"]);
export const jobTypeSchema = z.literal("archive-extraction");
export const jobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

// --- Role ---

export const roleSchema = z.enum(["owner", "admin", "editor", "viewer"]);

// --- Workspace ---

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const createWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(100),
});

// --- Member ---

export const memberSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: roleSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const addMemberBodySchema = z.object({
  userId: z.string(),
  role: roleSchema,
});

export const updateMemberBodySchema = z.object({
  role: roleSchema,
});

// --- Project ---

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  ownerId: z.string(),
  workspaceId: z.string().optional(),
});

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(100),
  workspaceId: z.string().optional(),
});

// --- Asset ---

export const assetVersionSchema = z.object({
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
});

export const assetMetadataSchema = z.object({
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
});

export const assetUploadResultSchema = z.object({
  asset: assetMetadataSchema,
  url: z.string(),
});

// --- Upload session ---

export const presignedUploadResultSchema = z.object({
  uploadId: z.string(),
  url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  contentEncoding: z.string().optional(),
  expiresAt: z.number(),
});

export const multipartUploadResultSchema = z.object({
  uploadId: z.string(),
  parts: z.array(z.object({
    partNumber: z.number(),
    url: z.string(),
  })),
  contentEncoding: z.string().optional(),
  expiresAt: z.number(),
});

export const uploadPartSchema = z.object({
  partNumber: z.number(),
  etag: z.string(),
});

// --- Job ---

export const jobSchema = z.object({
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
});

// --- File entry (archive manifest) ---

export const fileEntrySchema = z.object({
  path: z.string(),
  size: z.number(),
  contentType: z.string(),
  contentEncoding: z.string().optional(),
  hash: z.string().optional(),
});

// --- Request bodies ---

// S3 multipart upload allows at most 10000 parts; bound partCount to prevent
// client-side abuse (each part triggers an HMAC-SHA256 signature on the Worker).
export const MAX_UPLOAD_PARTS = 10000;

export const createUploadSessionBodySchema = z.object({
  filename: z.string(),
  contentType: z.string().optional(),
  size: z.number(),
  partCount: z.number().int().positive().max(MAX_UPLOAD_PARTS).optional(),
});

export const completeUploadBodySchema = z.object({
  parts: z.array(uploadPartSchema).optional(),
});

export const updateJobStatusBodySchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
  error: z.string().optional(),
});

// --- Asset update ---

export const updateAssetBodySchema = z.object({
  description: z.string().optional(),
  userMeta: z.record(z.string(), z.unknown()).optional(),
  activeVersionId: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
});

// --- Version update ---

export const updateVersionBodySchema = z.object({
  userMeta: z.record(z.string(), z.unknown()).optional(),
});

// --- Set active version ---

export const setActiveVersionBodySchema = z.object({
  versionId: z.string().nullable(),
});

// --- Error response ---

export const errorResponseSchema = z.object({
  error: z.string(),
});

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
