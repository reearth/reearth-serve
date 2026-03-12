import { z } from "zod";

// --- Enums ---

export const assetTypeSchema = z.enum(["file", "archive"]);
export const assetStatusSchema = z.enum(["pending", "ready", "extracting", "failed"]);
export const archiveFormatSchema = z.enum(["zip", "tar", "tar.gz", "tar.bz2"]);
export const jobTypeSchema = z.literal("archive-extraction");
export const jobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

// --- Asset ---

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
  error: z.string().optional(),
  fileCount: z.number().optional(),
  extractedSize: z.number().optional(),
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

export const createUploadSessionBodySchema = z.object({
  filename: z.string(),
  contentType: z.string().optional(),
  size: z.number(),
  partCount: z.number().optional(),
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

// --- Error response ---

export const errorResponseSchema = z.object({
  error: z.string(),
});

// --- Inferred types ---

export type AssetType = z.infer<typeof assetTypeSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type ArchiveFormat = z.infer<typeof archiveFormatSchema>;
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
