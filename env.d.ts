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
  // OIDC authentication
  OIDC_ISSUER_URL?: string;
  OIDC_AUDIENCE?: string;
  OIDC_CLIENT_ID?: string;
  // JWKS cache TTL (default: 3600s)
  JWKS_CACHE_TTL_SECONDS?: string;
  // Authorization
  CERBOS_ENDPOINT?: string;
  // Extraction settings
  EXTRACTION_STUCK_THRESHOLD_SECONDS?: string;
  // Cloudflare Containers
  ARCHIVE_EXTRACTOR?: DurableObjectNamespace;
  // Cloudflare Queues
  EXTRACTION_QUEUE?: Queue;
}
