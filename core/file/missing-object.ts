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
