import type { MiddlewareHandler } from "hono";
import { SignJWT, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload } from "jose";
import type { ServicePrincipal } from "../../auth/types";
import type { CompatCredential, CredentialId } from "../model";
import type { CompatStore } from "../repository";
import { gcsError, surfaceOf } from "./wire";

export type GcsEnv = { Variables: { service: ServicePrincipal } };

export type CredentialLookup = Pick<CompatStore, "findCredential" | "findCredentialByEmail">;

export type TokenConfig = {
  apiOrigin: string;
  secret: string | undefined;
  now: number;
};

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const MAX_ASSERTION_LIFETIME_SECONDS = 3600;
const CLOCK_TOLERANCE_SECONDS = 60;
const ACCESS_TOKEN_TYPE = "compat-at";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SELF_SIGNED_AUDIENCES = ["https://storage.googleapis.com/", "https://storage.googleapis.com"];

export type TokenGrant = { access_token: string; token_type: "Bearer"; expires_in: number };

export type TokenError = {
  error: "invalid_request" | "unsupported_grant_type" | "invalid_grant" | "temporarily_unavailable";
  error_description: string;
};

const invalidGrant: TokenError = { error: "invalid_grant", error_description: "Invalid JWT assertion." };

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function usable(credential: CompatCredential | null): credential is CompatCredential {
  return credential !== null && credential.revokedAt === null;
}

function withinLifetime(payload: JWTPayload): boolean {
  return typeof payload.iat === "number" && typeof payload.exp === "number"
    && payload.exp - payload.iat <= MAX_ASSERTION_LIFETIME_SECONDS;
}

function claimsOf(token: string): { header: ReturnType<typeof decodeProtectedHeader>; payload: JWTPayload } | null {
  try {
    return { header: decodeProtectedHeader(token), payload: decodeJwt(token) };
  } catch {
    return null;
  }
}

async function verifiedByCredential(
  token: string,
  credential: CompatCredential,
  now: number,
  audience: string[] | undefined,
): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, await importJWK(credential.publicJwk, "RS256"), {
      algorithms: ["RS256"],
      issuer: credential.clientEmail,
      audience,
      requiredClaims: ["exp", "iat"],
      currentDate: new Date(now),
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.sub !== undefined && payload.sub !== credential.clientEmail) return null;
    return withinLifetime(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The OAuth 2.0 jwt-bearer grant (RFC 7523) at the key file's `token_uri`,
 * which is what the Go client sends (ADR-019 Spike results).
 */
export async function exchangeAssertion(
  store: CredentialLookup,
  form: { grantType: string | undefined; assertion: string | undefined },
  cfg: TokenConfig,
): Promise<{ ok: true; value: TokenGrant } | { ok: false; status: 400 | 503; value: TokenError }> {
  if (form.grantType !== JWT_BEARER_GRANT) {
    return { ok: false, status: 400, value: { error: "unsupported_grant_type", error_description: `grant_type must be ${JWT_BEARER_GRANT}` } };
  }
  if (!form.assertion) {
    return { ok: false, status: 400, value: { error: "invalid_request", error_description: "assertion is required" } };
  }
  if (!cfg.secret) {
    return { ok: false, status: 503, value: { error: "temporarily_unavailable", error_description: "SIGNING_SECRET is not configured" } };
  }
  const claims = claimsOf(form.assertion);
  if (claims?.header.alg !== "RS256" || typeof claims.payload.iss !== "string") return { ok: false, status: 400, value: invalidGrant };
  const credential = await store.findCredentialByEmail(claims.payload.iss);
  if (!usable(credential)) return { ok: false, status: 400, value: invalidGrant };
  if (claims.header.kid !== undefined && claims.header.kid !== credential.id) return { ok: false, status: 400, value: invalidGrant };
  if (!await verifiedByCredential(form.assertion, credential, cfg.now, [`${cfg.apiOrigin}/token`])) {
    return { ok: false, status: 400, value: invalidGrant };
  }

  const iat = Math.floor(cfg.now / 1000);
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TOKEN_TYPE })
    .setSubject(credential.id)
    .setAudience(cfg.apiOrigin)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secretKey(cfg.secret));
  return { ok: true, value: { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS } };
}

async function verifyAccessToken(store: CredentialLookup, token: string, cfg: TokenConfig): Promise<CompatCredential | null> {
  if (!cfg.secret) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg.secret), {
      algorithms: ["HS256"],
      typ: ACCESS_TOKEN_TYPE,
      audience: cfg.apiOrigin,
      requiredClaims: ["sub", "exp"],
      currentDate: new Date(cfg.now),
    });
    const credential = await store.findCredential(payload.sub as CredentialId);
    return usable(credential) ? credential : null;
  } catch {
    return null;
  }
}

/**
 * A self-signed JWT sent as the bearer, as other Google client versions do:
 * RS256 with `kid` the credential id, `iss` its email, and either an
 * audience naming this API or Google's, or no audience and a `scope` claim.
 */
async function verifySelfSigned(store: CredentialLookup, token: string, kid: string, cfg: TokenConfig): Promise<CompatCredential | null> {
  const credential = await store.findCredential(kid as CredentialId);
  if (!usable(credential)) return null;
  const payload = claimsOf(token)?.payload;
  if (!payload) return null;
  const audience = payload.aud === undefined ? undefined : [cfg.apiOrigin, `${cfg.apiOrigin}/`, ...SELF_SIGNED_AUDIENCES];
  if (!audience && typeof payload.scope !== "string") return null;
  return await verifiedByCredential(token, credential, cfg.now, audience) ? credential : null;
}

export async function verifyBearer(store: CredentialLookup, token: string, cfg: TokenConfig): Promise<CompatCredential | null> {
  const header = claimsOf(token)?.header;
  if (header?.alg === "HS256" && header.typ === ACCESS_TOKEN_TYPE) return verifyAccessToken(store, token, cfg);
  if (header?.alg === "RS256" && typeof header.kid === "string") return verifySelfSigned(store, token, header.kid, cfg);
  return null;
}

export function servicePrincipal(credential: CompatCredential): ServicePrincipal {
  return {
    kind: "service",
    id: credential.id,
    grant: { projectId: credential.projectId, bucket: credential.bucket, role: credential.role },
    revokedAt: credential.revokedAt,
  };
}

export function gcsAuth(store: CredentialLookup, cfg: Omit<TokenConfig, "now">): MiddlewareHandler<GcsEnv> {
  return async (c, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const credential = bearer ? await verifyBearer(store, bearer, { ...cfg, now: Date.now() }) : null;
    if (!credential) return gcsError(surfaceOf(c.req.path), "unauthenticated");
    c.set("service", servicePrincipal(credential));
    await next();
  };
}

if (import.meta.vitest) {
  const { test, expect, describe } = import.meta.vitest;
  const { importPKCS8 } = await import("jose");
  const { issueCredential } = await import("../credential");
  type BucketName = import("../model").BucketName;

  const API = "http://storage.example.test:8788";
  const NOW = 1_800_000_000_000;
  const cfg: TokenConfig = { apiOrigin: API, secret: "test-signing-secret", now: NOW };

  async function issued() {
    const { credential, keyFile } = await issueCredential({
      projectId: "p1", bucket: "media" as BucketName, role: "editor", label: null, createdBy: "u1", apiOrigin: API, now: 0,
    });
    const rows = new Map([[credential.id, credential]]);
    const store: CredentialLookup = {
      findCredential: async (id) => rows.get(id) ?? null,
      findCredentialByEmail: async (email) => [...rows.values()].find((c) => c.clientEmail === email) ?? null,
    };
    const revoke = () => rows.set(credential.id, { ...credential, revokedAt: NOW });
    return { credential, keyFile, store, revoke };
  }

  type Claims = { iss?: string; sub?: string; aud?: string; scope?: string; iat?: number; exp?: number };

  async function sign(privateKeyPem: string, kid: string, claims: Claims): Promise<string> {
    const iat = Math.floor(NOW / 1000);
    return new SignJWT({ ...(claims.scope ? { scope: claims.scope } : {}), ...(claims.sub ? { sub: claims.sub } : {}) })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(claims.iss ?? "")
      .setIssuedAt(claims.iat ?? iat)
      .setExpirationTime(claims.exp ?? iat + 3600)
      .setAudience(claims.aud ?? `${API}/token`)
      .sign(await importPKCS8(privateKeyPem, "RS256"));
  }

  async function assertion(k: Awaited<ReturnType<typeof issued>>, claims: Claims = {}, key = k.keyFile.private_key) {
    return sign(key, k.keyFile.private_key_id, { iss: k.keyFile.client_email, ...claims });
  }

  const grant = (a: string) => ({ grantType: JWT_BEARER_GRANT, assertion: a });

  describe("exchangeAssertion", () => {
    test("a valid assertion buys an access token that verifies to the same credential", async () => {
      const k = await issued();
      const res = await exchangeAssertion(k.store, grant(await assertion(k)), cfg);
      if (!res.ok) throw new Error(res.value.error);
      expect(res.value).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
      expect(decodeJwt(res.value.access_token)).toEqual({ sub: k.credential.id, aud: API, iat: NOW / 1000, exp: NOW / 1000 + 3600 });
      expect(await verifyBearer(k.store, res.value.access_token, cfg)).toEqual(k.credential);
    });

    test.each<[string, (k: Awaited<ReturnType<typeof issued>>) => Promise<string>]>([
      ["an expired assertion", (k) => assertion(k, { iat: NOW / 1000 - 7200, exp: NOW / 1000 - 3600 })],
      ["a wrong audience", (k) => assertion(k, { aud: "https://oauth2.googleapis.com/token" })],
      ["a lifetime over one hour", (k) => assertion(k, { exp: NOW / 1000 + 3601 })],
      ["a sub other than the email", (k) => assertion(k, { sub: "someone@else.test" })],
      ["an unknown email", (k) => assertion(k, { iss: "nobody@storage.example.test" })],
      ["another credential's key", async (k) => assertion(k, {}, (await issued()).keyFile.private_key)],
    ])("%s is invalid_grant", async (_, make) => {
      const k = await issued();
      expect(await exchangeAssertion(k.store, grant(await make(k)), cfg)).toEqual({ ok: false, status: 400, value: invalidGrant });
    });

    test("a revoked credential is invalid_grant", async () => {
      const k = await issued();
      const a = await assertion(k);
      k.revoke();
      expect(await exchangeAssertion(k.store, grant(a), cfg)).toEqual({ ok: false, status: 400, value: invalidGrant });
    });

    test("a malformed request is refused before any lookup", async () => {
      const k = await issued();
      expect((await exchangeAssertion(k.store, { grantType: "client_credentials", assertion: "x" }, cfg)).ok).toBe(false);
      expect(await exchangeAssertion(k.store, { grantType: JWT_BEARER_GRANT, assertion: "not.a.jwt" }, cfg))
        .toEqual({ ok: false, status: 400, value: invalidGrant });
      expect(await exchangeAssertion(k.store, { grantType: JWT_BEARER_GRANT, assertion: undefined }, cfg))
        .toMatchObject({ ok: false, value: { error: "invalid_request" } });
    });

    test("without a signing secret the endpoint is unavailable", async () => {
      const k = await issued();
      expect(await exchangeAssertion(k.store, grant(await assertion(k)), { ...cfg, secret: undefined }))
        .toMatchObject({ ok: false, status: 503, value: { error: "temporarily_unavailable" } });
    });
  });

  describe("verifyBearer", () => {
    async function accessToken(k: Awaited<ReturnType<typeof issued>>, at = cfg) {
      const res = await exchangeAssertion(k.store, grant(await assertion(k, { iat: at.now / 1000, exp: at.now / 1000 + 3600 })), at);
      if (!res.ok) throw new Error(res.value.error);
      return res.value.access_token;
    }

    test("a revoked credential's cached access token stops working at once", async () => {
      const k = await issued();
      const token = await accessToken(k);
      k.revoke();
      expect(await verifyBearer(k.store, token, cfg)).toBeNull();
    });

    test("an expired access token, another secret or another API origin is refused", async () => {
      const k = await issued();
      const token = await accessToken(k);
      expect(await verifyBearer(k.store, token, { ...cfg, now: NOW + 3601_000 })).toBeNull();
      expect(await verifyBearer(k.store, token, { ...cfg, secret: "another-secret" })).toBeNull();
      expect(await verifyBearer(k.store, token, { ...cfg, apiOrigin: "http://other.test" })).toBeNull();
    });

    test("a self-signed JWT with kid the credential id is accepted for this API, Google's audience, or a scope", async () => {
      const k = await issued();
      for (const claims of [{ aud: API }, { aud: `${API}/` }, { aud: "https://storage.googleapis.com/" }]) {
        expect(await verifyBearer(k.store, await assertion(k, claims), cfg)).toEqual(k.credential);
      }
      const scoped = await new SignJWT({ scope: "https://www.googleapis.com/auth/devstorage.full_control" })
        .setProtectedHeader({ alg: "RS256", kid: k.credential.id })
        .setIssuer(k.credential.clientEmail).setSubject(k.credential.clientEmail)
        .setIssuedAt(NOW / 1000).setExpirationTime(NOW / 1000 + 3600)
        .sign(await importPKCS8(k.keyFile.private_key, "RS256"));
      expect(await verifyBearer(k.store, scoped, cfg)).toEqual(k.credential);
    });

    test("a self-signed JWT is refused when expired, for another audience, under another key, revoked, or for an unknown kid", async () => {
      const k = await issued();
      const other = await issued();
      expect(await verifyBearer(k.store, await assertion(k, { aud: API, iat: NOW / 1000 - 7200, exp: NOW / 1000 - 3600 }), cfg)).toBeNull();
      expect(await verifyBearer(k.store, await assertion(k, { aud: "https://elsewhere.test" }), cfg)).toBeNull();
      expect(await verifyBearer(k.store, await assertion(k, { aud: API }, other.keyFile.private_key), cfg)).toBeNull();
      expect(await verifyBearer(k.store, await sign(other.keyFile.private_key, other.credential.id, { iss: other.credential.clientEmail, aud: API }), cfg)).toBeNull();
      const valid = await assertion(k, { aud: API });
      k.revoke();
      expect(await verifyBearer(k.store, valid, cfg)).toBeNull();
    });

    test("anything else is refused", async () => {
      const k = await issued();
      expect(await verifyBearer(k.store, "opaque", cfg)).toBeNull();
      const unsignedType = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(k.credential.id)
        .setAudience(API).setExpirationTime(NOW / 1000 + 60).sign(secretKey(cfg.secret!));
      expect(await verifyBearer(k.store, unsignedType, cfg)).toBeNull();
    });
  });

  test("the service principal carries the credential's project, bucket and role", async () => {
    const { credential } = await issued();
    expect(servicePrincipal(credential)).toEqual({
      kind: "service", id: credential.id, grant: { projectId: "p1", bucket: "media", role: "editor" }, revokedAt: null,
    });
  });
}
