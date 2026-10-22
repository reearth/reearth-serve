import { z } from "zod";
import {
  assetMetadataSchema, assetUploadResultSchema, assetVersionSchema, jobSchema,
  projectSchema, workspaceSchema, memberSchema, roleSchema,
  errorResponseSchema, fileEntrySchema,
  presignedUploadResultSchema, multipartUploadResultSchema,
  createUploadSessionBodySchema, completeUploadBodySchema,
  createProjectBodySchema, createWorkspaceBodySchema,
  addMemberBodySchema, updateMemberBodySchema,
  updateAssetBodySchema, updateVersionBodySchema, setActiveVersionBodySchema,
  siteHostSchema, siteHostVerificationSchema, claimSiteHostBodySchema,
  updateSiteHostBodySchema,
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

export const versionResponseSchema = z.object({ version: assetVersionSchema });
export const versionListResponseSchema = z.object({
  versions: z.array(assetVersionSchema),
  cursor: z.string().optional(),
});

export const siteHostResponseSchema = z.object({
  host: siteHostSchema,
  /** The same value as `host.url`, alongside the upload response's `siteUrl`. */
  siteUrl: z.string(),
}).extend(siteHostVerificationSchema.partial().shape);
export const siteHostListResponseSchema = z.object({ hosts: z.array(siteHostSchema) });

/**
 * `409` from `POST …/hosts/:hostname/verify` (ADR-013 B5): the record was not
 * found, so the body repeats what the customer has to publish.
 */
export const siteHostVerificationFailedSchema = errorResponseSchema
  .extend(siteHostVerificationSchema.shape);

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  anonymousUploadEnabled: z.boolean(),
});

export const uploadResultResponseSchema = assetUploadResultSchema;

// Upload session can return either presigned or multipart
export const uploadSessionResponseSchema = z.union([
  presignedUploadResultSchema,
  multipartUploadResultSchema,
]);

// --- Param schemas ---

export const idParamSchema = z.object({ id: z.string() });
export const versionParamSchema = z.object({ id: z.string(), versionId: z.string() });
export const workspaceMemberParamSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
});
export const workspaceIdParamSchema = z.object({ workspaceId: z.string() });
export const siteHostParamSchema = z.object({ id: z.string(), hostname: z.string() });

// --- Query schemas ---

export const paginationQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

export const scopedListQuerySchema = paginationQuerySchema.extend({
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
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
  updateAssetBodySchema,
  updateVersionBodySchema,
  setActiveVersionBodySchema,
  claimSiteHostBodySchema,
  updateSiteHostBodySchema,
  errorResponseSchema,
  fileEntrySchema,
};
