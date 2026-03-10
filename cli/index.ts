import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { lookup } from "./mime";

const DEFAULT_ENDPOINT = "http://localhost:8787";
const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const PART_SIZE = 100 * 1024 * 1024; // 100MB per part
const MAX_CONCURRENCY = 4;

interface UploadResult {
  asset: { id: string };
  url: string;
}

interface SingleSessionResponse {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

interface MultipartSessionResponse {
  uploadId: string;
  parts: { partNumber: number; url: string }[];
}

function isMultipartResponse(res: SingleSessionResponse | MultipartSessionResponse): res is MultipartSessionResponse {
  return "parts" in res;
}

async function uploadPartWithRetry(url: string, data: Uint8Array, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "PUT",
      body: data as BodyInit,
    });

    if (res.ok) {
      const etag = res.headers.get("ETag");
      if (!etag) throw new Error("Missing ETag in part upload response");
      return etag;
    }

    if (attempt === retries) {
      const body = await res.text();
      throw new Error(`Part upload failed (${res.status}): ${body}`);
    }
  }
  throw new Error("Unreachable");
}

async function uploadViaPresigned(
  endpoint: string,
  fileName: string,
  contentType: string,
  fileData: Uint8Array,
): Promise<UploadResult | null> {
  const isMultipart = fileData.byteLength > MULTIPART_THRESHOLD;
  const partCount = isMultipart ? Math.ceil(fileData.byteLength / PART_SIZE) : undefined;

  // Step 1: Create upload session
  const initRes = await fetch(`${endpoint}/assets/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: fileName,
      contentType,
      size: fileData.byteLength,
      partCount,
    }),
  });

  if (initRes.status === 501) return null; // not available, fallback to direct
  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`Upload session creation failed (${initRes.status}): ${body}`);
  }

  const session = await initRes.json() as SingleSessionResponse | MultipartSessionResponse;

  // Step 2: Upload file data
  if (isMultipartResponse(session)) {
    // Multipart: upload parts in parallel with concurrency limit
    const parts = session.parts;
    const etags: { partNumber: number; etag: string }[] = [];

    for (let i = 0; i < parts.length; i += MAX_CONCURRENCY) {
      const batch = parts.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (part) => {
          const start = (part.partNumber - 1) * PART_SIZE;
          const end = Math.min(start + PART_SIZE, fileData.byteLength);
          const chunk = fileData.subarray(start, end);
          const etag = await uploadPartWithRetry(part.url, chunk);
          return { partNumber: part.partNumber, etag };
        }),
      );
      etags.push(...results);
    }

    // Step 3: Complete multipart upload
    const completeRes = await fetch(`${endpoint}/assets/uploads/${session.uploadId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: etags }),
    });

    if (!completeRes.ok) {
      const body = await completeRes.text();
      throw new Error(`Upload completion failed (${completeRes.status}): ${body}`);
    }

    return completeRes.json() as Promise<UploadResult>;
  }

  // Single PUT upload
  const putRes = await fetch(session.url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileData as BodyInit,
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Direct upload to storage failed (${putRes.status}): ${body}`);
  }

  // Step 3: Complete single upload
  const completeRes = await fetch(`${endpoint}/assets/uploads/${session.uploadId}/complete`, {
    method: "POST",
  });

  if (!completeRes.ok) {
    const body = await completeRes.text();
    throw new Error(`Upload completion failed (${completeRes.status}): ${body}`);
  }

  return completeRes.json() as Promise<UploadResult>;
}

async function uploadDirect(
  endpoint: string,
  fileName: string,
  contentType: string,
  fileData: Uint8Array,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", new Blob([fileData as BlobPart], { type: contentType }), fileName);

  const res = await fetch(`${endpoint}/assets`, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<UploadResult>;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: reearth-serve <file> [--endpoint <url>]

Upload a file and get a public URL.

Options:
  --endpoint <url>  Server endpoint (default: ${DEFAULT_ENDPOINT})
  --direct          Force direct upload (skip presigned URL)
  --json            Output JSON instead of just the URL
  --help, -h        Show this help`);
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  let endpoint = DEFAULT_ENDPOINT;
  let jsonOutput = false;
  let directMode = false;
  let filePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--endpoint" && args[i + 1]) {
      endpoint = args[++i];
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--direct") {
      directMode = true;
    } else if (!args[i].startsWith("-")) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error("Error: No file specified.");
    console.error("Hint:  Run `reearth-serve --help` for usage.");
    process.exit(1);
  }

  try {
    statSync(filePath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const fileName = basename(filePath);
  const fileData = new Uint8Array(readFileSync(filePath));
  const contentType = lookup(fileName);

  let data: UploadResult;

  if (directMode) {
    data = await uploadDirect(endpoint, fileName, contentType, fileData);
  } else {
    // Try presigned URL first, fallback to direct
    const presigned = await uploadViaPresigned(endpoint, fileName, contentType, fileData);
    if (presigned) {
      data = presigned;
    } else {
      data = await uploadDirect(endpoint, fileName, contentType, fileData);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data.url);
  }
}

main();
