// `skipExtraction` on an upload session: the counterpart of the direct
// upload's `X-Skip-Extraction` header. The request schema used to strip the
// field, so `--no-extract` had no effect on presigned uploads.
import { beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { PresignedUrlGenerator } from "../../core/asset/repository";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

// Not a real zip: completion decides extraction from the file name and never
// reads the bytes, and the extraction queue send is spied, not consumed.
const BODY = "PK\x03\x04 not really a zip";

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  runtime = buildNodeRuntime({ ANONYMOUS_UPLOAD_ENABLED: "true" });
  const store = runtime.deps.storage as MemoryFileStorage;
  const presigned: PresignedUrlGenerator = {
    generatePutUrl: vi.fn(async (key: string) => {
      await store.put(key, new Blob([BODY]).stream(), "application/zip", BODY.length);
      return { url: `https://store.example/${key}`, headers: {} };
    }),
    createMultipartUpload: vi.fn(async () => "mp-1"),
    generateUploadPartUrl: vi.fn(async (key: string) => `https://store.example/${key}`),
    completeMultipartUpload: vi.fn(async () => {}),
    abortMultipartUpload: vi.fn(async () => {}),
  };
  runtime.deps.presignedUrls = presigned;
  app = createApp(runtime.deps);
});

async function uploadZip(extra: Record<string, unknown>, complete = true): Promise<Record<string, unknown> | undefined> {
  let sessionId = "";
  const post = async (path: string, body?: object) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method: "POST",
      ...(body && { body: JSON.stringify(body) }),
      headers: { ...(body && { "Content-Type": "application/json" }), ...(sessionId && { "X-Session-Id": sessionId }) },
    }));
    sessionId ||= res.headers.get("X-Session-Id") ?? "";
    return res;
  };
  const created = await post("/api/v1/assets/uploads", {
    filename: "data.zip", contentType: "application/zip", size: BODY.length, ...extra,
  });
  expect(created.status).toBe(201);
  const { uploadId } = (await created.json()) as { uploadId: string };
  if (!complete) return undefined;
  const done = await post(`/api/v1/assets/uploads/${uploadId}/complete`);
  expect(done.status).toBe(201);
  return ((await done.json()) as { asset: Record<string, unknown> }).asset;
}

test("an archive uploaded through a session is extracted by default", async () => {
  const send = vi.spyOn(runtime.deps.extractionQueue!, "send");
  const asset = await uploadZip({});
  expect(asset?.status).toBe("pending");
  expect(send).toHaveBeenCalled();
});

test("skipExtraction: true stores the archive without extracting it (single PUT)", async () => {
  const send = vi.spyOn(runtime.deps.extractionQueue!, "send");
  const asset = await uploadZip({ skipExtraction: true });
  expect(asset).not.toHaveProperty("status");
  expect(send).not.toHaveBeenCalled();
});

test("skipExtraction: true is kept on a multipart session", async () => {
  const save = vi.spyOn(runtime.deps.uploadSessions, "save");
  await uploadZip({ skipExtraction: true, partCount: 2 }, false);
  const saved = save.mock.calls[0][0];
  expect(saved).toMatchObject({ partCount: 2, skipExtraction: true });
});
