/**
 * One answer for an unknown bucket, an unknown key and an access refusal, and
 * `no-store`, since the key may be written a moment later.
 */
export function missingObjectResponse(): Response {
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
