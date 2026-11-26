import type { CompatHost } from "./hosts";
import type { LocatedObject, ObjectReader } from "./layer";
import { parseBucketName, parseObjectKey, type ObjectKey } from "./model";
import { TOKEN_QUERY } from "../access/request";
import { SITE_PREVIEW_HEADER } from "../site/middleware";

export type ObjectsHost = Extract<CompatHost, { kind: "objects-path-style" | "objects-virtual-host" }>;

const ALLOW = "GET, HEAD";

/**
 * The read-only public objects host (ADR-019 §6). A key is resolved to its
 * asset, then the request is handed to `/files/{asset}/{filename}` on the
 * objects-host router, so a visitor here meets the access checks and caching
 * of `/files`, with the apex's disposition.
 */
export function objectsHost(reader: ObjectReader, deliver: (request: Request) => Response | Promise<Response>) {
  return async (host: ObjectsHost, request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
    const url = new URL(request.url);
    const target = targetOf(host, url.pathname);
    const located = target && await reader.locate(target.bucket, target.key);
    if (!located) return notFound();
    const res = await deliver(filesRequest(request, url, located));
    if (!refused(res.status)) return res;
    await res.body?.cancel().catch(() => {});
    return notFound();
  };
}

/**
 * Keys are names, not capabilities, so a challenge or a refusal would confirm
 * that a protected object exists. Every one reads as a missing key; a 416
 * comes only after access was granted.
 */
const refused = (status: number) => status >= 400 && status !== 416;

function targetOf(host: ObjectsHost, rawPath: string): { bucket: string; key: ObjectKey } | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath).slice(1);
  } catch {
    return null;
  }
  if (host.kind === "objects-virtual-host") {
    const key = parseObjectKey(path);
    return key && { bucket: host.bucket, key };
  }
  const slash = path.indexOf("/");
  const bucket = slash > 0 && parseBucketName(path.slice(0, slash));
  const key = bucket && parseObjectKey(path.slice(slash + 1));
  return bucket && key ? { bucket, key } : null;
}

/** Only a delivery token travels in the query; every other parameter is the objects host's to ignore. */
function filesRequest(request: Request, url: URL, { assetId, filename }: LocatedObject): Request {
  const files = new URL(`/files/${encodeURIComponent(assetId)}/${encodeURIComponent(filename)}`, url);
  for (const token of url.searchParams.getAll(TOKEN_QUERY)) files.searchParams.append(TOKEN_QUERY, token);
  const headers = new Headers(request.headers);
  headers.delete(SITE_PREVIEW_HEADER);
  return new Request(files, { method: request.method, headers });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { Allow: ALLOW, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/** One answer for an unknown bucket, an unknown key and every refusal, and `no-store`, since the key may be written a moment later. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "File not found" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After",
    },
  });
}
