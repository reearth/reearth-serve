import type { Hono } from "hono";
import { describeRoute, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { accessCtx, authorizeProject, deniedResponse } from "../auth/access";
import { jsonError, jsonResponse } from "../openapi";
import { idParamSchema } from "../../shared/openapi";
import type { z } from "zod";
import {
  compatBucketListSchema, compatBucketParamSchema, compatBucketResponseSchema, compatCredentialListSchema,
  compatCredentialParamSchema, compatCredentialSchema, compatKeyFileSchema, createCompatBucketBodySchema,
  issueCompatCredentialBodySchema,
} from "../../shared/compat";
import { isServiceRole } from "../auth/types";
import { parseBucketName, parseNewBucketName, type CompatCredential, type CredentialId } from "./model";
import { issueCredential } from "./credential";

function toCredentialDto(c: CompatCredential): z.infer<typeof compatCredentialSchema> {
  return {
    id: c.id, projectId: c.projectId, bucket: c.bucket, role: c.role, clientEmail: c.clientEmail,
    label: c.label, createdBy: c.createdBy, createdAt: c.createdAt, revokedAt: c.revokedAt,
  };
}

export function compatApiOrigin(apiHost: string | undefined, baseUrl: string): string | null {
  if (!apiHost) return null;
  return `${new URL(baseUrl).protocol}//${apiHost}`;
}

export function registerProjectCompatRoutes(app: Hono<AppEnv>) {
  app.get("/:id/compat/buckets",
    describeRoute({
      tags: ["Projects"],
      summary: "List compat buckets of a project",
      responses: {
        200: jsonResponse("Buckets in the project", compatBucketListSchema),
        401: jsonError("Authentication required"),
        404: jsonError("Project not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
      const access = await authorizeProject(accessCtx(c),c.req.valid("param").id, "read");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found" });
      return c.json({ buckets: await c.get("compat").listBuckets(access.value.id) });
    },
  );

  app.post("/:id/compat/buckets",
    describeRoute({
      tags: ["Projects"],
      summary: "Create a compat bucket",
      description:
        "Creates a bucket name that the storage compatibility API (ADR-019) maps onto this project's assets. " +
        "Names are unique across the server and follow GCS naming; `storage`, `upload`, `download` and `batch` are refused, because the API's own paths start with them. `mount` maps every key under a folder to one archive asset. Admin or above.",
      responses: {
        201: jsonResponse("Bucket created", compatBucketResponseSchema),
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Project not found"),
        409: jsonError("Bucket name is taken"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", createCompatBucketBodySchema),
    async (c) => {
      if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
      const access = await authorizeProject(accessCtx(c),c.req.valid("param").id, "manage_compat");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found", forbiddenAs: 403 });

      const body = c.req.valid("json");
      const name = parseNewBucketName(body.name);
      if (!name) return c.json({ error: "Invalid bucket name" }, 400);
      const bucket = { name, projectId: access.value.id, mount: body.mount ?? null, createdAt: Date.now() };
      if (!await c.get("compat").insertBucket(bucket)) return c.json({ error: "Bucket name is taken" }, 409);
      return c.json({ bucket }, 201);
    },
  );

  app.delete("/:id/compat/buckets/:bucket",
    describeRoute({
      tags: ["Projects"],
      summary: "Delete a compat bucket",
      description:
        "Deletes an empty bucket and revokes every credential bound to it. A bucket that still maps a key answers 409; " +
        "the assets themselves are never touched. Admin or above.",
      responses: {
        204: { description: "Bucket deleted" },
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Project or bucket not found"),
        409: jsonError("Bucket is not empty"),
      },
    }),
    zValidator("param", compatBucketParamSchema),
    async (c) => {
      if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
      const { id, bucket } = c.req.valid("param");
      const access = await authorizeProject(accessCtx(c),id, "manage_compat");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found", forbiddenAs: 403 });

      const name = parseBucketName(bucket);
      const result = name ? await c.get("compat").deleteBucket(access.value.id, name, Date.now()) : "absent";
      if (result === "absent") return c.json({ error: "Bucket not found" }, 404);
      if (result === "not_empty") return c.json({ error: "Bucket is not empty" }, 409);
      return c.body(null, 204);
    },
  );

  app.get("/:id/compat/credentials",
    describeRoute({
      tags: ["Projects"],
      summary: "List compat credentials of a project",
      description: "Revoked credentials stay listed with `revokedAt` set. No private key is ever returned again. Admin or above.",
      responses: {
        200: jsonResponse("Credentials in the project", compatCredentialListSchema),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Project not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
      const access = await authorizeProject(accessCtx(c),c.req.valid("param").id, "manage_compat");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found", forbiddenAs: 403 });
      const credentials = await c.get("compat").listCredentials(access.value.id);
      return c.json({ credentials: credentials.map(toCredentialDto) });
    },
  );

  app.post("/:id/compat/credentials",
    describeRoute({
      tags: ["Projects"],
      summary: "Issue a compat credential",
      description:
        "Generates an RSA-2048 key pair and answers with a Google service-account key file for one bucket of this " +
        "project. The private key is in this response only. Admin or above.",
      responses: {
        201: jsonResponse("Key file", compatKeyFileSchema),
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Project not found, or the bucket is not in it"),
        503: jsonError("COMPAT_GCS_HOST is not configured"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", issueCompatCredentialBodySchema),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Authentication required" }, 401);
      const access = await authorizeProject(accessCtx(c),c.req.valid("param").id, "manage_compat");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found", forbiddenAs: 403 });

      if (!access.value.workspaceId) return c.json({ error: "Credentials need a project in a workspace" }, 400);
      const body = c.req.valid("json");
      if (!isServiceRole(body.role)) return c.json({ error: "role must be viewer or editor" }, 400);
      const name = parseBucketName(body.bucket);
      const bucket = name ? await c.get("compat").findBucket(name) : null;
      if (!bucket || bucket.projectId !== access.value.id) return c.json({ error: "Bucket not found" }, 404);
      const apiOrigin = compatApiOrigin(c.get("compatApiHost"), c.get("baseUrl"));
      if (!apiOrigin) return c.json({ error: "Storage compatibility API is not configured" }, 503);

      const { credential, keyFile } = await issueCredential({
        projectId: bucket.projectId,
        bucket: bucket.name,
        role: body.role,
        label: body.label || null,
        createdBy: user.id,
        apiOrigin,
        now: Date.now(),
      });
      if (!await c.get("compat").insertCredential(credential)) return c.json({ error: "Bucket not found" }, 404);
      return c.json(keyFile, 201);
    },
  );

  app.delete("/:id/compat/credentials/:credentialId",
    describeRoute({
      tags: ["Projects"],
      summary: "Revoke a compat credential",
      description: "Revocation is immediate and idempotent; the first revocation time is kept. Admin or above.",
      responses: {
        204: { description: "Credential revoked" },
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Project or credential not found"),
      },
    }),
    zValidator("param", compatCredentialParamSchema),
    async (c) => {
      if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
      const { id, credentialId } = c.req.valid("param");
      const access = await authorizeProject(accessCtx(c),id, "manage_compat");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found", forbiddenAs: 403 });
      const revoked = await c.get("compat").revokeCredential(access.value.id, credentialId as CredentialId, Date.now());
      return revoked ? c.body(null, 204) : c.json({ error: "Credential not found" }, 404);
    },
  );
}
