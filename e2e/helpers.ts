export const BASE = process.env.E2E_ENDPOINT ?? "http://localhost:8787";

export function rewriteUrl(url: string): string {
  const parsed = new URL(url);
  const base = new URL(BASE);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}

export async function uploadFile(
  content: Uint8Array,
  filename: string,
  contentType: string,
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append("file", new Blob([content as BlobPart], { type: contentType }), filename);
  const res = await fetch(`${BASE}/assets`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}
