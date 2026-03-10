interface Env {
  STORAGE: R2Bucket;
  KV: KVNamespace;
  ASSET_TTL_SECONDS: string;
  BASE_URL: string;
  // Presigned URL upload (production only — not available in local dev)
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}
