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
  component,
} from "./api";

// --- Response envelopes ---

export const assetResponseSchema = component("AssetResponse", z.object({ asset: assetMetadataSchema }));
export const assetListResponseSchema = component("AssetListResponse", z.object({
  assets: z.array(assetMetadataSchema),
  cursor: z.string().optional(),
}));

export const jobResponseSchema = component("JobResponse", z.object({ job: jobSchema }));
export const jobListResponseSchema = component("JobListResponse", z.object({
  jobs: z.array(jobSchema),
  cursor: z.string().optional(),
}));

export const projectResponseSchema = component("ProjectResponse", z.object({ project: projectSchema }));
export const projectListResponseSchema = component("ProjectListResponse", z.object({ projects: z.array(projectSchema) }));

export const workspaceResponseSchema = component("WorkspaceResponse", z.object({ workspace: workspaceSchema }));

export const memberResponseSchema = component("MemberResponse", z.object({ member: memberSchema }));
export const memberListResponseSchema = component("MemberListResponse", z.object({ members: z.array(memberSchema) }));

export const meResponseSchema = component("MeResponse", z.object({
  user: z.object({ sub: z.string(), email: z.string().optional(), name: z.string().optional() }),
  workspaces: z.array(workspaceSchema.extend({ role: roleSchema })),
}));

export const versionResponseSchema = component("VersionResponse", z.object({ version: assetVersionSchema }));
export const versionListResponseSchema = component("VersionListResponse", z.object({
  versions: z.array(assetVersionSchema),
  cursor: z.string().optional(),
}));

export const siteHostResponseSchema = component("SiteHostResponse", z.object({
  host: siteHostSchema,
  /** The same value as `host.url`, alongside the upload response's `siteUrl`. */
  siteUrl: z.string(),
}).extend(siteHostVerificationSchema.partial().shape));
export const siteHostListResponseSchema = component("SiteHostList", z.object({ hosts: z.array(siteHostSchema) }));

/**
 * `409` from `POST …/hosts/:hostname/verify` (ADR-013 B5): the record was not
 * found, so the body repeats what the customer has to publish.
 */
export const siteHostVerificationFailedSchema = component("SiteHostVerificationFailed", errorResponseSchema
  .extend(siteHostVerificationSchema.shape));

export const versionUploadResultResponseSchema = component("VersionUploadResponse", z.object({
  version: assetVersionSchema,
  url: z.string(),
}));

export const healthResponseSchema = component("HealthResponse", z.object({
  ok: z.boolean(),
  anonymousUploadEnabled: z.boolean(),
}));

export const uploadResultResponseSchema = assetUploadResultSchema;

// Upload session can return either presigned or multipart
export const uploadSessionResponseSchema = component("UploadSessionResponse", z.union([
  presignedUploadResultSchema,
  multipartUploadResultSchema,
]));

// --- Param schemas ---

export const idParamSchema = z.object({ id: z.string() });
export const versionParamSchema = z.object({ id: z.string(), versionId: z.string() });
export const workspaceMemberParamSchema = z.object({
  id: z.string(),
  userId: z.string(),
});
export const workspaceIdParamSchema = z.object({ workspaceId: z.string() });
export const siteHostParamSchema = z.object({ id: z.string(), hostname: z.string() });

// --- Query schemas ---

export const paginationQuerySchema = z.object({
  limit: z.string().optional().describe("Page size. Default 20, maximum 100."),
  cursor: z.string().optional().describe("Opaque cursor from the previous page's `cursor`; omit for the first page."),
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
