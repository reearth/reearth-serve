import { z } from "zod";
import {
  assetMetadataSchema, assetUploadResultSchema, jobSchema,
  projectSchema, workspaceSchema, memberSchema, roleSchema,
  errorResponseSchema, fileEntrySchema,
  presignedUploadResultSchema, multipartUploadResultSchema,
  createUploadSessionBodySchema, completeUploadBodySchema,
  createProjectBodySchema, createWorkspaceBodySchema,
  addMemberBodySchema, updateMemberBodySchema,
} from "./api";

// --- Response envelopes ---

export const assetResponseSchema = z.object({ asset: assetMetadataSchema });
export const assetListResponseSchema = z.object({
  assets: z.array(assetMetadataSchema),
  cursor: z.string().optional(),
});

export const jobResponseSchema = z.object({ job: jobSchema });
export const jobListResponseSchema = z.object({
  jobs: z.array(jobSchema),
  cursor: z.string().optional(),
});

export const projectResponseSchema = z.object({ project: projectSchema });
export const projectListResponseSchema = z.object({ projects: z.array(projectSchema) });

export const workspaceResponseSchema = z.object({ workspace: workspaceSchema });

export const memberResponseSchema = z.object({ member: memberSchema });
export const memberListResponseSchema = z.object({ members: z.array(memberSchema) });

export const meResponseSchema = z.object({
  user: z.object({ sub: z.string(), email: z.string().optional(), name: z.string().optional() }),
  workspaces: z.array(workspaceSchema.extend({ role: roleSchema })),
});

export const healthResponseSchema = z.object({ ok: z.boolean() });

export const uploadResultResponseSchema = assetUploadResultSchema;

// Upload session can return either presigned or multipart
export const uploadSessionResponseSchema = z.union([
  presignedUploadResultSchema,
  multipartUploadResultSchema,
]);

// --- Param schemas ---

export const idParamSchema = z.object({ id: z.string() });
export const workspaceMemberParamSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
});
export const workspaceIdParamSchema = z.object({ workspaceId: z.string() });

// --- Query schemas ---

export const paginationQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export const projectListQuerySchema = z.object({
  workspaceId: z.string().optional(),
});

export const fileListQuerySchema = z.object({
  prefix: z.string().optional(),
});

// Re-export body schemas for convenience
export {
  createUploadSessionBodySchema,
  completeUploadBodySchema,
  createProjectBodySchema,
  createWorkspaceBodySchema,
  addMemberBodySchema,
  updateMemberBodySchema,
  errorResponseSchema,
  fileEntrySchema,
};
