import type { Context, Hono, MiddlewareHandler } from "hono";
import { describeRoute, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { resolveAssetVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { mintPrefix, mintResponse, planMint } from "../../access/mint";
import { toUnixSeconds } from "../../access/token";
import { createSignedUrlBodySchema, signedUrlSchema } from "../../../shared/api";
import { idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";
import { signedUrlExamples } from "../../openapi-examples";

/** Where `createApp` mounts the route's CORS, ahead of auth. */
export const SIGNED_URLS_PATH = "/api/v1/assets/:id/signed-urls";

/**
 * CORS for the mint route (ADR-014 §4 Mint). The proof is a bearer the caller
 * attaches, so `*` gives no origin anything a cookie would. It runs before auth
 * and tenancy so their refusals, and `onError`'s 503, are readable too.
 */
export const signedUrlCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "86400",
    });
  }
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.delete("Access-Control-Allow-Credentials");
  c.res.headers.set("Access-Control-Expose-Headers", "Retry-After");
};

function tokensOff(c: Context<AppEnv>): Response {
  return c.json({ error: "Delivery tokens are not configured" }, 501);
}

export function registerSignedUrlsRoute(app: Hono<AppEnv>) {
  app.post("/:id/signed-urls",
    describeRoute({
      tags: ["Assets"],
      summary: "Mint a delivery token",
      description: [
        "Sign a delivery token (ADR-014 §4) for a path prefix inside the asset. A restricted asset's files accept it as the `serve_token` query parameter or the `X-Serve-Token` header, on the apex and on site hosts.",
        "",
        "`id` is an asset ID or a version ID. A version ID pins the token to that version, and so does `versionId` in the body. An unpinned token follows the asset to every version.",
        "",
        "The caller needs `read_asset` on the asset. Public and restricted assets mint; password-protected ones do not.",
        "Every response, preflights and refusals included, carries `Access-Control-Allow-Origin: *` and no credentials header.",
      ].join("\n"),
      responses: {
        200: jsonResponse("The token and a URL template for it", signedUrlSchema, signedUrlExamples),
        400: jsonError("Invalid body or prefix, a password-protected asset, or a versionId that is not a version of this asset"),
        404: jsonError("Asset not found"),
        501: jsonError("Delivery tokens are not configured (`DELIVERY_TOKEN_KEYS` unset)"),
      },
    }),
    async (c, next) => (c.get("deliveryTokens") ? next() : tokensOff(c)),
    zValidator("param", idParamSchema),
    zValidator("json", createSignedUrlBodySchema),
    async (c) => {
      const tokens = c.get("deliveryTokens");
      if (!tokens) return tokensOff(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const prefix = mintPrefix(body.prefix ?? "");
      if (prefix === null) return c.json({ error: "Invalid prefix" }, 400);

      const resolved = await resolveAssetVersion(c.get("metadata"), c.get("versions"), id);
      const access = await authorizeAsset(accessCtx(c), resolved?.asset ?? null, "read_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const now = toUnixSeconds(Date.now());
      const plan = planMint({
        asset,
        urlVersionId: asset.id === id ? null : id,
        bodyVersion: body.versionId === undefined
          ? null
          : { id: body.versionId, found: await c.get("versions").find(body.versionId) },
        prefix,
        expiresIn: body.expiresIn,
        now,
      });
      if (!plan.ok) return c.json({ error: plan.error }, 400);

      const token = await tokens.sign(plan.claims, now);
      return c.json(mintResponse(token, plan.claims, c.get("baseUrl")), 200);
    },
  );
}
