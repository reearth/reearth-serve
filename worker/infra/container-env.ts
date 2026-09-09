export interface ObjectStoreCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Object store environment for the Go containers (ADR-012 step 2).
 *
 * The containers read the provider-neutral `OBJECT_STORE_*` names and fall back
 * to the deprecated `R2_*` ones. We emit both for one release so a container
 * image that has not been rebuilt yet keeps working. Drop the `R2_*` half once
 * the images in production read the new names.
 *
 * Lives outside container.ts so it can be unit-tested without the
 * `cloudflare:workers` runtime that `@cloudflare/containers` pulls in.
 */
export function objectStoreEnv(
  objectStore: ObjectStoreCredentials,
): Record<string, string> {
  return {
    OBJECT_STORE_ENDPOINT: objectStore.endpoint,
    OBJECT_STORE_ACCESS_KEY_ID: objectStore.accessKeyId,
    OBJECT_STORE_SECRET_ACCESS_KEY: objectStore.secretAccessKey,
    OBJECT_STORE_BUCKET: objectStore.bucket,
    // Deprecated aliases, kept for one release.
    R2_ENDPOINT: objectStore.endpoint,
    R2_ACCESS_KEY_ID: objectStore.accessKeyId,
    R2_SECRET_ACCESS_KEY: objectStore.secretAccessKey,
    R2_BUCKET: objectStore.bucket,
  };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("objectStoreEnv", () => {
    const credentials: ObjectStoreCredentials = {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
    };

    it("emits the OBJECT_STORE_* names", () => {
      expect(objectStoreEnv(credentials)).toMatchObject({
        OBJECT_STORE_ENDPOINT: credentials.endpoint,
        OBJECT_STORE_ACCESS_KEY_ID: credentials.accessKeyId,
        OBJECT_STORE_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        OBJECT_STORE_BUCKET: credentials.bucket,
      });
    });

    it("still emits the deprecated R2_* names for one release", () => {
      expect(objectStoreEnv(credentials)).toMatchObject({
        R2_ENDPOINT: credentials.endpoint,
        R2_ACCESS_KEY_ID: credentials.accessKeyId,
        R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        R2_BUCKET: credentials.bucket,
      });
    });

    it("emits nothing else", () => {
      expect(Object.keys(objectStoreEnv(credentials)).sort()).toEqual([
        "OBJECT_STORE_ACCESS_KEY_ID",
        "OBJECT_STORE_BUCKET",
        "OBJECT_STORE_ENDPOINT",
        "OBJECT_STORE_SECRET_ACCESS_KEY",
        "R2_ACCESS_KEY_ID",
        "R2_BUCKET",
        "R2_ENDPOINT",
        "R2_SECRET_ACCESS_KEY",
      ]);
    });
  });
}
