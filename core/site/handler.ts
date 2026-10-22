/**
 * The site-hosts API (ADR-013 B6).
 *
 * ```
 * GET    /api/v1/assets/:id/hosts
 * POST   /api/v1/assets/:id/hosts   {hostname, kind?}
 * PATCH  /api/v1/assets/:id/hosts/:hostname   {disabled?, previews?}
 * DELETE /api/v1/assets/:id/hosts/:hostname
 * GET    /api/v1/projects/:id/hosts
 * ```
 *
 * The asset routes hang off `assetRoutes` and the project one off
 * `projectRoutes`; both live here so the whole surface of one feature reads in
 * one file. Authorization is the asset's: `canAccessAsset` with the
 * `manage-hosts` action, which is editor-and-above (the same rule as an asset
 * update), so a viewer can list names but not claim or release one.
 */

import type { Hono } from "hono";
import { describeRoute, resolver, validator as zValidator } from "hono-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { canAccessAsset } from "../asset/access";
import { accessCtx } from "../asset/handler/shared";
import { getAssetMetadata } from "../asset/usecase";
import type { SiteHost as SiteHostRow } from "./repository";
import {
  claimSiteHost, cnameTarget, getAssetSiteHost, listAssetSiteHosts,
  listProjectSiteHosts, refreshCertificateStatus, releaseSiteHost, siteHostUrl,
  updateSiteHost, verifySiteHost, type SiteHostDeps,
} from "./usecase";
import { customHostInstructions, type CustomHostInstructions } from "./custom";
import type { SiteHost as SiteHostDto } from "../../shared/api";
import {
  claimSiteHostBodySchema, errorResponseSchema, idParamSchema,
  siteHostListResponseSchema, siteHostParamSchema, siteHostResponseSchema,
  siteHostVerificationFailedSchema, updateSiteHostBodySchema,
} from "../../shared/openapi";

/** The action name checked against the role map (core/auth/roles.ts). */
export const MANAGE_HOSTS_ACTION = "manage-hosts";

export function siteHostDeps(c: Context<AppEnv>): SiteHostDeps {
  return {
    hosts: c.get("siteHosts"),
    cache: c.get("cache"),
    suffix: c.get("siteHostSuffix"),
    baseUrl: c.get("baseUrl"),
    dns: c.get("dns"),
    provisioner: c.get("customHostnames"),
    fallbackOrigin: c.get("siteFallbackOrigin"),
  };
}

/** The row as the API shows it: internal-only columns dropped, URL added. */
export function toSiteHostDto(host: SiteHostRow, baseUrl: string): SiteHostDto {
  return {
    hostname: host.hostname,
    assetId: host.assetId,
    projectId: host.projectId,
    kind: host.kind,
    previews: host.previews,
    verifiedAt: host.verifiedAt,
    certificateStatus: host.certificateStatus,
    disabledAt: host.disabledAt,
    releasedAt: host.releasedAt,
    createdAt: host.createdAt,
    url: siteHostUrl(host.hostname, baseUrl),
  };
}

/**
 * The DNS the customer still has to publish (ADR-013 B5), or nothing.
 *
 * Shown while a custom row is unverified and withheld once it is: after
 * verification the record has served its purpose, and echoing the token back
 * on every read would spread a secret for no reason.
 */
function pendingInstructions(
  host: SiteHostRow,
  deps: SiteHostDeps,
): CustomHostInstructions | Record<string, never> {
  if (host.kind !== "custom" || host.verifiedAt !== null) return {};
  return customHostInstructions(host, cnameTarget(deps));
}

export function registerAssetHostRoutes(app: Hono<AppEnv>) {
  app.get("/:id/hosts",
    describeRoute({
      tags: ["Assets"],
      summary: "List site hosts of an asset",
      description: "Named hosts (ADR-013 B2) currently pointing at this asset. Released names are not listed.",
      responses: {
        200: { description: "Host list", content: { "application/json": { schema: resolver(siteHostListResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const asset = await getAssetMetadata(c.get("metadata"), c.req.valid("param").id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "read")) {
        return c.json({ error: "Asset not found" }, 404);
      }
      const hosts = await listAssetSiteHosts(siteHostDeps(c), asset.id);
      return c.json({ hosts: hosts.map((h) => toSiteHostDto(h, c.get("baseUrl"))) });
    },
  );

  app.post("/:id/hosts",
    describeRoute({
      tags: ["Assets"],
      summary: "Claim a site host for an asset",
      description:
        "Claims a name (ADR-013 B2) or registers a custom domain (B5). For `subdomain`, " +
        "`hostname` may be the bare label or the full host. For `custom` it is the whole " +
        "hostname the customer owns; the response carries the TXT record to publish and " +
        "the CNAME target, and the host does not resolve until `POST …/verify` passes. " +
        "Project archive assets only; editor or above; 20 active names per project.",
      responses: {
        201: { description: "Host claimed", content: { "application/json": { schema: resolver(siteHostResponseSchema) } } },
        400: { description: "Invalid, reserved, taken or on cooldown", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        503: { description: "Site hosts are not enabled on this server", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", claimSiteHostBodySchema),
    async (c) => {
      const asset = await getAssetMetadata(c.get("metadata"), c.req.valid("param").id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), MANAGE_HOSTS_ACTION)) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const deps = siteHostDeps(c);
      const body = c.req.valid("json");
      const result = await claimSiteHost(deps, {
        asset,
        hostname: body.hostname,
        kind: body.kind,
        userId: c.get("user")?.sub ?? null,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);

      const host = toSiteHostDto(result.host, c.get("baseUrl"));
      return c.json(
        { host, siteUrl: host.url, ...pendingInstructions(result.host, deps) },
        201,
      );
    },
  );

  app.get("/:id/hosts/:hostname",
    describeRoute({
      tags: ["Assets"],
      summary: "Get one site host of an asset",
      description:
        "The row, plus — while a custom domain (ADR-013 B5) is unverified — the TXT record " +
        "to publish and the CNAME target. On a verified custom domain whose certificate is " +
        "not active yet, the status is refreshed from the provider before answering.",
      responses: {
        200: { description: "The host", content: { "application/json": { schema: resolver(siteHostResponseSchema) } } },
        404: { description: "Asset or host not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", siteHostParamSchema),
    async (c) => {
      const { id, hostname } = c.req.valid("param");
      const asset = await getAssetMetadata(c.get("metadata"), id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "read")) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const deps = siteHostDeps(c);
      const row = await getAssetSiteHost(deps, { assetId: asset.id, hostname });
      if (!row) return c.json({ error: "Host not found" }, 404);

      // One provider call, and only while something is still outstanding: it
      // is what turns "pending" into "active" without the operator polling.
      const fresh = await refreshCertificateStatus(deps, row);
      const host = toSiteHostDto(fresh, c.get("baseUrl"));
      return c.json({ host, siteUrl: host.url, ...pendingInstructions(fresh, deps) }, 200);
    },
  );

  app.post("/:id/hosts/:hostname/verify",
    describeRoute({
      tags: ["Assets"],
      summary: "Verify a custom domain",
      description:
        "Looks up `TXT _reearth-serve-verify.<hostname>` (ADR-013 B5). When it carries this " +
        "row's token the host is verified, certificate issuance starts and the domain begins " +
        "resolving; otherwise the record to publish is returned with a 409. Attempts are rate " +
        "limited per hostname. Verifying an already-verified domain refreshes its certificate " +
        "status.",
      responses: {
        200: { description: "Verified", content: { "application/json": { schema: resolver(siteHostResponseSchema) } } },
        400: { description: "Not a custom domain", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset or host not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        409: { description: "The verification record was not found", content: { "application/json": { schema: resolver(siteHostVerificationFailedSchema) } } },
        429: { description: "Too many verification attempts", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", siteHostParamSchema),
    async (c) => {
      const { id, hostname } = c.req.valid("param");
      const asset = await getAssetMetadata(c.get("metadata"), id);
      // Verification publishes a hostname, so it is a change to the asset's
      // site, not a read of it: the same bar as claim and release.
      if (!asset || !await canAccessAsset(asset, accessCtx(c), MANAGE_HOSTS_ACTION)) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const deps = siteHostDeps(c);
      const result = await verifySiteHost(deps, { assetId: asset.id, hostname });
      if (!result.ok) {
        // A 409 repeats the instructions: the caller is standing at their DNS
        // console and should not have to go and fetch the record again.
        if (result.status === 409) {
          const row = await getAssetSiteHost(deps, { assetId: asset.id, hostname });
          return c.json(
            { error: result.error, ...(row ? customHostInstructions(row, cnameTarget(deps)) : {}) },
            409,
          );
        }
        return c.json({ error: result.error }, result.status);
      }

      const host = toSiteHostDto(result.host, c.get("baseUrl"));
      return c.json({ host, siteUrl: host.url }, 200);
    },
  );

  app.patch("/:id/hosts/:hostname",
    describeRoute({
      tags: ["Assets"],
      summary: "Update a site host's publish state or preview flag",
      description:
        "Disables or enables a name (ADR-013 B3) and toggles `v{n}--` / `latest--` " +
        "preview hosts (B4). A disabled name is held and answers 503. Released names " +
        "cannot be updated.",
      responses: {
        200: { description: "Host updated", content: { "application/json": { schema: resolver(siteHostResponseSchema) } } },
        400: { description: "Neither field was given, or previews were asked for on a custom domain", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset or host not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        409: { description: "The name has been released", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", siteHostParamSchema),
    zValidator("json", updateSiteHostBodySchema),
    async (c) => {
      const { id, hostname } = c.req.valid("param");
      const asset = await getAssetMetadata(c.get("metadata"), id);
      // Same bar as claiming and releasing: taking a public site down is a
      // change to it, not a read of it.
      if (!asset || !await canAccessAsset(asset, accessCtx(c), MANAGE_HOSTS_ACTION)) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const body = c.req.valid("json");
      const result = await updateSiteHost(siteHostDeps(c), {
        assetId: asset.id,
        projectId: asset.projectId,
        hostname,
        disabled: body.disabled,
        previews: body.previews,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);

      const host = toSiteHostDto(result.host, c.get("baseUrl"));
      return c.json({ host, siteUrl: host.url }, 200);
    },
  );

  app.delete("/:id/hosts/:hostname",
    describeRoute({
      tags: ["Assets"],
      summary: "Release a site host",
      description:
        "Releases the name (ADR-013 B3). The host answers 410 for 30 days and the name " +
        "cannot be claimed again until that cooldown ends.",
      responses: {
        204: { description: "Host released" },
        404: { description: "Asset or host not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", siteHostParamSchema),
    async (c) => {
      const { id, hostname } = c.req.valid("param");
      const asset = await getAssetMetadata(c.get("metadata"), id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), MANAGE_HOSTS_ACTION)) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const result = await releaseSiteHost(siteHostDeps(c), { assetId: asset.id, hostname });
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.body(null, 204);
    },
  );
}

export function registerProjectHostRoutes(app: Hono<AppEnv>) {
  app.get("/:id/hosts",
    describeRoute({
      tags: ["Projects"],
      summary: "List site hosts of a project",
      responses: {
        200: { description: "Host list", content: { "application/json": { schema: resolver(siteHostListResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Project not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "Authentication required" }, 401);

      // Same visibility rule as GET /projects/:id — owner, or a member of the
      // project's workspace — and the same 404 for everyone else, so the
      // endpoint does not confirm that a project exists.
      const project = await c.get("projects").find(c.req.valid("param").id);
      if (!project) return c.json({ error: "Project not found" }, 404);
      const isOwner = project.ownerId === user.sub;
      const isMember = project.workspaceId
        ? (await c.get("members").find(project.workspaceId, user.sub)) !== null
        : false;
      if (!isOwner && !isMember) return c.json({ error: "Project not found" }, 404);

      const hosts = await listProjectSiteHosts(siteHostDeps(c), project.id);
      return c.json({ hosts: hosts.map((h) => toSiteHostDto(h, c.get("baseUrl"))) });
    },
  );
}
