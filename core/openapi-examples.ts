import type {
  AssetMetadata, AssetUploadResult, CompleteUploadBody, CreateUploadSessionBody,
  FileEntry, MultipartUploadResult, PresignedUploadResult, SignedUrl,
} from "../shared/api";

// Request / response examples for the OpenAPI document (`describeRoute`
// media-type `examples`). Typed against the shared API types so a schema change
// that breaks an example fails `tsc`; core/openapi.test.ts also runs Redocly's
// example validation over the generated document.

type Example<T> = { summary: string; description?: string; value: T };

const BASE = "https://serve.example.com";
const EXPIRES_AT = 1767312000000; // 2026-01-02T00:00:00Z
const CREATED_AT = 1767225600000; // 2026-01-01T00:00:00Z
const PART_URL = "https://storage.example.com/assets/8f3a2c1d9b7e4f60/city.zip?partNumber=";

// --- Upload sessions (POST /api/v1/assets/uploads) ---

export const createUploadSessionExamples = {
  single: {
    summary: "Single PUT (omit partCount)",
    value: { filename: "buildings.geojson", contentType: "application/geo+json", size: 52_428_800 },
  },
  multipart: {
    summary: "Multipart (partCount > 1)",
    description: "Split the file into `partCount` parts; every part except the last must be at least 5 MiB. The CLI uses 100 MiB parts.",
    value: { filename: "city.zip", contentType: "application/zip", size: 314_572_800, partCount: 3 },
  },
} satisfies Record<string, Example<CreateUploadSessionBody>>;

export const uploadSessionExamples = {
  single: {
    summary: "Single PUT",
    description: "PUT the file to `url` with exactly `headers`. `contentEncoding: gzip` means the server chose to store it compressed: gzip the body before uploading. Then call `POST /api/v1/assets/uploads/{id}/complete` with no body.",
    value: {
      uploadId: "5d1e7b0c2a9f4e38",
      url: "https://storage.example.com/assets/5d1e7b0c2a9f4e38/buildings.geojson?X-Amz-Signature=…",
      method: "PUT",
      headers: { "Content-Type": "application/geo+json", "Content-Encoding": "gzip" },
      contentEncoding: "gzip",
      expiresAt: EXPIRES_AT,
    },
  } satisfies Example<PresignedUploadResult>,
  multipart: {
    summary: "Multipart",
    description: "PUT bytes `[(partNumber - 1) × partSize, partNumber × partSize)` to each part's `url` (in parallel if you like), keep each response's `ETag` header, then send them all to `POST /api/v1/assets/uploads/{id}/complete`.",
    value: {
      uploadId: "8f3a2c1d9b7e4f60",
      parts: [1, 2, 3].map((n) => ({ partNumber: n, url: `${PART_URL}${n}&uploadId=…&X-Amz-Signature=…` })),
      expiresAt: EXPIRES_AT,
    },
  } satisfies Example<MultipartUploadResult>,
};

// --- Completing an upload (POST /api/v1/assets/uploads/{id}/complete) ---

export const completeUploadExamples = {
  multipart: {
    summary: "Multipart: every part's ETag",
    description: "One entry per part, with the `ETag` response header of its PUT (quotes included). Single-PUT sessions send no body.",
    value: {
      parts: [
        { partNumber: 1, etag: "\"a54357aff0632cce46d942af68356b38\"" },
        { partNumber: 2, etag: "\"0c78aef83f66abc1fa1e8477f296d394\"" },
        { partNumber: 3, etag: "\"acbd18db4cc2f85cedef654fccc4a4d8\"" },
      ],
    },
  },
} satisfies Record<string, Example<CompleteUploadBody>>;

const archiveAsset: AssetMetadata = {
  id: "8f3a2c1d9b7e4f60",
  filename: "city.zip",
  contentType: "application/zip",
  size: 314_572_800,
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  type: "archive",
  status: "pending",
  archiveFormat: "zip",
  jobId: "e41b9d27c06a4f8d",
  projectId: "p_2b7c9e10",
};

export const assetUploadResultExamples = {
  archive: {
    summary: "Archive queued for extraction",
    description: "Archives get `status: pending` and a `jobId`; poll `GET /api/v1/jobs/{id}` (or the asset) until `ready`. Its entries are then served at `/files/{id}/{entry path}`.",
    value: { asset: archiveAsset, url: `${BASE}/files/8f3a2c1d9b7e4f60/city.zip` },
  },
  file: {
    summary: "Plain file",
    value: {
      asset: {
        id: "5d1e7b0c2a9f4e38",
        filename: "buildings.geojson",
        contentType: "application/geo+json",
        size: 9_437_184,
        originalSize: 52_428_800,
        contentEncoding: "gzip",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        type: "file",
        status: "ready",
        projectId: "p_2b7c9e10",
      },
      url: `${BASE}/files/5d1e7b0c2a9f4e38/buildings.geojson`,
    },
  },
} satisfies Record<string, Example<AssetUploadResult>>;

// --- File listing (GET /api/v1/assets/{id}/files, application/x-ndjson) ---

const archiveEntries: FileEntry[] = [
  { path: "tileset.json", size: 4_812, contentType: "application/json", contentEncoding: "gzip", hash: "md5:5eb63bbbe01eeed093cb22bb8f5acdc3" },
  { path: "tiles/0/0/0.b3dm", size: 1_048_576, contentType: "application/octet-stream", hash: "md5:7215ee9c7d9dc229d2921a40e899ec5f" },
  { path: "tiles/1/0/0.b3dm", size: 786_432, contentType: "application/octet-stream", hash: "md5:e4d909c290d0fb1ca068ffaddf22cbd0" },
];

/** NDJSON body: one FileEntry per line, newline-terminated. */
export const fileListExamples = {
  archive: {
    summary: "Extracted archive",
    description: "One FileEntry JSON object per line (`\\n`-terminated), streamed in manifest order. `hash` is `md5:<hex>`. Filter with `?prefix=tiles/`.",
    value: archiveEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  },
  file: {
    summary: "Single-file asset",
    description: "A plain file yields one line.",
    value: JSON.stringify({ path: "buildings.geojson", size: 9_437_184, contentType: "application/geo+json", hash: "md5:3b5d5c3712955042212316173ccf37be" } satisfies FileEntry) + "\n",
  },
  empty: {
    summary: "No match",
    description: "No entry matches `prefix` (or the archive is not extracted yet): an empty body.",
    value: "",
  },
} satisfies Record<string, Example<string>>;

// --- Signed URLs (POST /api/v1/assets/{id}/signed-urls) ---

const TOKEN = "eyJ2IjoxLCJraWQiOiJrMSIsImFzc2V0SWQiOiI4ZjNhMmMxZDliN2U0ZjYwIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMzItYnl0ZXMtbG9uZw";

export const signedUrlExamples = {
  asset: {
    summary: "Follows the asset",
    value: { token: TOKEN, expiresAt: EXPIRES_AT, urlTemplate: `${BASE}/files/8f3a2c1d9b7e4f60/{path}?serve_token=${TOKEN}` },
  },
} satisfies Record<string, Example<SignedUrl>>;

// --- Health (GET /api/v1/health) ---

export const healthExamples = {
  ok: { summary: "Healthy", value: { ok: true, anonymousUploadEnabled: true } },
};

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const schemas = await import("../shared/openapi");
  const api = await import("../shared/api");

  // tsc checks the shapes; this also runs refinements (e.g. filename rules,
  // partCount bounds) and NDJSON framing.
  test.each([
    ["create upload session", schemas.createUploadSessionBodySchema, createUploadSessionExamples],
    ["upload session", schemas.uploadSessionResponseSchema, uploadSessionExamples],
    ["complete upload", schemas.completeUploadBodySchema, completeUploadExamples],
    ["asset upload result", schemas.uploadResultResponseSchema, assetUploadResultExamples],
    ["health", schemas.healthResponseSchema, healthExamples],
    ["signed URL", api.signedUrlSchema, signedUrlExamples],
  ] as const)("%s examples parse with their schema", (_, schema, examples) => {
    for (const [name, { value }] of Object.entries(examples)) {
      expect(schema.safeParse(value).success, name).toBe(true);
    }
  });

  test("NDJSON examples are newline-terminated FileEntry lines", () => {
    for (const [name, { value }] of Object.entries(fileListExamples)) {
      if (value === "") continue;
      expect(value.endsWith("\n"), name).toBe(true);
      for (const line of value.slice(0, -1).split("\n")) {
        expect(schemas.fileEntrySchema.safeParse(JSON.parse(line)).success, `${name}: ${line}`).toBe(true);
      }
    }
  });
}
