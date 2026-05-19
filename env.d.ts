// .wasm files imported in Workers code are bundled by wrangler/vite and surface
// as WebAssembly.Module values. There's no upstream type declaration, so
// declare a generic shape for both bare-specifier and relative-path imports.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

interface Env {
  STORAGE: R2Bucket;
  KV: KVNamespace;
  DB: D1Database;
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
  // Shared secret for /api/internal/* (container ↔ worker callbacks).
  // Required in production; without it the internal API rejects every request.
  INTERNAL_API_SECRET?: string;
  // Extraction settings
  EXTRACTION_STUCK_THRESHOLD_SECONDS?: string;
  // Anonymous (demo-mode) upload toggle. Set to "false" to require login for uploads.
  // Defaults to "true" — read & non-upload operations are not affected.
  ANONYMOUS_UPLOAD_ENABLED?: string;
  // Cloudflare Containers
  ARCHIVE_EXTRACTOR?: DurableObjectNamespace;
  THUMBNAIL_GENERATOR?: DurableObjectNamespace;
  // Cloudflare Queues
  EXTRACTION_QUEUE?: Queue;
  THUMBNAIL_QUEUE?: Queue;
}
