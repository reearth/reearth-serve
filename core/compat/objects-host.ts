import type { CompatHost } from "./hosts";
import type { ObjectReader, UnauthorizedLookup } from "./layer";
import { parseBucketName, parseObjectKey, type ObjectKey } from "./model";
import { decoyPasswordCheck } from "../access/password";
import { TOKEN_QUERY } from "../access/request";
import { SITE_PREVIEW_HEADER } from "../site/middleware";
import { missingObjectResponse } from "../file/missing-object";

export type ObjectsHost = Extract<CompatHost, { kind: "objects-path-style" | "objects-virtual-host" | "objects-no-bucket" }>;

export function objectsHost(reader: ObjectReader, deliver: (request: Request) => Response | Promise<Response>) {
  return async (host: ObjectsHost, request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
    const url = new URL(request.url);
    const target = targetOf(host, url.pathname);
    const located = target && await reader.locate(target.bucket, target.key);
    if (!located) {
      await decoyPasswordCheck(request.headers.get("Authorization"));
      return missingObjectResponse();
    }
    const res = await deliver(filesRequest(request, url, located));
    if (res.status !== 404) return res;
    await res.body?.cancel().catch(() => {});
    return missingObjectResponse();
  };
}

function targetOf(host: ObjectsHost, rawPath: string): { bucket: string; key: ObjectKey } | null {
  if (host.kind === "objects-no-bucket") return null;
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

function filesRequest(request: Request, url: URL, { assetId }: UnauthorizedLookup): Request {
  const files = new URL(`/files/${encodeURIComponent(assetId)}`, url);
  for (const token of url.searchParams.getAll(TOKEN_QUERY)) files.searchParams.append(TOKEN_QUERY, token);
  const headers = new Headers(request.headers);
  headers.delete(SITE_PREVIEW_HEADER);
  return new Request(files, { method: request.method, headers });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { Allow: "GET, HEAD", "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
