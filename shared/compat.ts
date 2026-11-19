import { z } from "zod";
import { component, enumComponent, roleSchema } from "./api";

export const compatStripRuleSchema = enumComponent("CompatStripRule", z.enum(["none", "skip-top"]));

export const compatMountRuleSchema = component("CompatMountRule", z.object({
  prefix: z.string().refine((p) => p === "" || (p.endsWith("/") && !p.startsWith("/")), {
    message: "prefix must be empty, or end in '/' and not start with it",
  }),
  depth: z.number().int().min(1).max(8),
  strip: compatStripRuleSchema,
}).describe("How a key maps to the folder that names one asset: `depth` path segments after `prefix`."));

export const compatBucketSchema = component("CompatBucket", z.object({
  name: z.string(),
  projectId: z.string(),
  mount: compatMountRuleSchema.nullable(),
  createdAt: z.number(),
}));

export const createCompatBucketBodySchema = component("CreateCompatBucketRequest", z.object({
  name: z.string().describe("GCS bucket name rules: 3 to 63 lowercase letters, digits, '-', '_' and '.'. Unique across the server."),
  mount: compatMountRuleSchema.optional(),
}));

export const compatBucketResponseSchema = component("CompatBucketResponse", z.object({ bucket: compatBucketSchema }));
export const compatBucketListSchema = component("CompatBucketList", z.object({ buckets: z.array(compatBucketSchema) }));

export const issueCompatCredentialBodySchema = component("IssueCompatCredentialRequest", z.object({
  bucket: z.string().describe("The one bucket of this project the credential reaches."),
  role: roleSchema,
  label: z.string().max(200).optional(),
}).describe("`role` is `viewer` or `editor`: a credential acts on assets only, so `admin` and `owner` are refused with 400."));

export const compatKeyFileSchema = component("CompatKeyFile", z.object({
  type: z.literal("service_account"),
  project_id: z.string(),
  private_key_id: z.string(),
  private_key: z.string(),
  client_email: z.string(),
  client_id: z.string(),
  token_uri: z.string(),
}).describe("A Google service-account key file. Returned once; Serve keeps only the public key."));

export const compatCredentialSchema = component("CompatCredential", z.object({
  id: z.string(),
  projectId: z.string(),
  bucket: z.string(),
  role: roleSchema,
  clientEmail: z.string(),
  label: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
}));

export const compatCredentialListSchema = component("CompatCredentialList", z.object({
  credentials: z.array(compatCredentialSchema),
}));

export const compatBucketParamSchema = z.object({ id: z.string(), bucket: z.string() });
export const compatCredentialParamSchema = z.object({ id: z.string(), credentialId: z.string() });
