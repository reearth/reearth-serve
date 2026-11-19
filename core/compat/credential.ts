import type { ServiceRole } from "../auth/types";
import type { BucketName, CompatCredential, CredentialId } from "./model";

/** The fields of a Google service-account key file that client libraries read. */
export type KeyFile = {
  type: "service_account";
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
};

export type IssueInput = {
  projectId: string;
  bucket: BucketName;
  role: ServiceRole;
  label: string | null;
  createdBy: string;
  apiOrigin: string;
  now: number;
};

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

export async function issueCredential(input: IssueInput): Promise<{ credential: CompatCredential; keyFile: KeyFile }> {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
  const [pkcs8, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16) as CredentialId;
  const clientEmail = `${id}@${new URL(input.apiOrigin).hostname}`;
  const credential: CompatCredential = {
    id,
    projectId: input.projectId,
    bucket: input.bucket,
    role: input.role,
    clientEmail,
    publicJwk: { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, alg: "RS256" },
    label: input.label,
    createdBy: input.createdBy,
    createdAt: input.now,
    revokedAt: null,
  };
  const keyFile: KeyFile = {
    type: "service_account",
    project_id: input.projectId,
    private_key_id: id,
    private_key: toPem(new Uint8Array(pkcs8)),
    client_email: clientEmail,
    client_id: id,
    token_uri: `${input.apiOrigin}/token`,
  };
  return { credential, keyFile };
}

function toPem(der: Uint8Array): string {
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const { SignJWT, importJWK, importPKCS8, jwtVerify } = await import("jose");

  const input: IssueInput = {
    projectId: "p1",
    bucket: "media" as BucketName,
    role: "editor",
    label: "cms",
    createdBy: "u1",
    apiOrigin: "https://storage.example.test:8443",
    now: 1000,
  };

  test("a JWT signed with the issued private key verifies with the stored public JWK", async () => {
    const { credential, keyFile } = await issueCredential(input);
    const jwt = await new SignJWT({ scope: "devstorage" })
      .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id })
      .setIssuer(keyFile.client_email)
      .setAudience(keyFile.token_uri)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await importPKCS8(keyFile.private_key, "RS256"));
    const { payload, protectedHeader } = await jwtVerify(jwt, await importJWK(credential.publicJwk, "RS256"), {
      issuer: credential.clientEmail,
      audience: "https://storage.example.test:8443/token",
    });
    expect(protectedHeader.kid).toBe(credential.id);
    expect(payload.scope).toBe("devstorage");
  });

  test("a JWT signed with another credential's key does not verify", async () => {
    const a = await issueCredential(input);
    const b = await issueCredential(input);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).sign(await importPKCS8(b.keyFile.private_key, "RS256"));
    await expect(jwtVerify(jwt, await importJWK(a.credential.publicJwk, "RS256"))).rejects.toThrow();
  });

  test("the key file names the credential, the project and the token endpoint, and the row holds no private part", async () => {
    const { credential, keyFile } = await issueCredential(input);
    expect(keyFile).toEqual({
      type: "service_account",
      project_id: "p1",
      private_key_id: credential.id,
      private_key: expect.stringMatching(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/),
      client_email: `${credential.id}@storage.example.test`,
      client_id: credential.id,
      token_uri: "https://storage.example.test:8443/token",
    });
    expect(credential).toMatchObject({ bucket: "media", role: "editor", revokedAt: null, createdAt: 1000 });
    expect(Object.keys(credential.publicJwk).sort()).toEqual(["alg", "e", "kty", "n"]);
  });
}
