export type GcsErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bucket_not_found"
  | "object_not_found"
  | "not_implemented"
  | "backend_error";

type ErrorSpec = { status: 401 | 403 | 404 | 500 | 501; reason: string; xmlCode: string; message: string };

const ERRORS: Record<GcsErrorCode, ErrorSpec> = {
  unauthenticated: { status: 401, reason: "authError", xmlCode: "AuthenticationRequired", message: "Invalid Credentials" },
  forbidden: { status: 403, reason: "forbidden", xmlCode: "AccessDenied", message: "Access denied." },
  bucket_not_found: { status: 404, reason: "notFound", xmlCode: "NoSuchBucket", message: "The specified bucket does not exist." },
  object_not_found: { status: 404, reason: "notFound", xmlCode: "NoSuchKey", message: "The specified key does not exist." },
  not_implemented: { status: 501, reason: "notImplemented", xmlCode: "NotImplemented", message: "This operation is not implemented by this server." },
  backend_error: { status: 500, reason: "backendError", xmlCode: "InternalError", message: "We encountered an internal error. Please try again." },
};

export type GcsSurface = "json" | "xml";

export function surfaceOf(path: string): GcsSurface {
  return /^\/(storage|upload\/storage|batch\/storage)\/v1(\/|$)/.test(path) ? "json" : "xml";
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function gcsError(surface: GcsSurface, code: GcsErrorCode, message?: string): Response {
  const spec = ERRORS[code];
  const text = message ?? spec.message;
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (spec.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="storage"';
  if (surface === "json") {
    const body = { error: { code: spec.status, message: text, errors: [{ message: text, domain: "global", reason: spec.reason }] } };
    return Response.json(body, { status: spec.status, headers });
  }
  const xml = `<?xml version='1.0' encoding='UTF-8'?><Error><Code>${spec.xmlCode}</Code><Message>${escapeXml(text)}</Message></Error>`;
  return new Response(xml, { status: spec.status, headers: { ...headers, "Content-Type": "application/xml; charset=UTF-8" } });
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test.each([
    ["/storage/v1/b/media/o/k", "json"],
    ["/upload/storage/v1/b/media/o", "json"],
    ["/batch/storage/v1", "json"],
    ["/media/assets/a.txt", "xml"],
    ["/storage", "xml"],
    ["/storage/v10/b", "xml"],
  ])("%s is the %s API", (path, surface) => {
    expect(surfaceOf(path)).toBe(surface);
  });

  test("the JSON shape is what googleapi.Error parses", async () => {
    const res = gcsError("json", "not_implemented");
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: {
        code: 501,
        message: "This operation is not implemented by this server.",
        errors: [{ message: "This operation is not implemented by this server.", domain: "global", reason: "notImplemented" }],
      },
    });
  });

  test("the XML shape names the S3-style code and escapes the message", async () => {
    const res = gcsError("xml", "object_not_found", "No <such> key");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=UTF-8");
    expect(await res.text()).toBe("<?xml version='1.0' encoding='UTF-8'?><Error><Code>NoSuchKey</Code><Message>No &#60;such&#62; key</Message></Error>");
  });

  test("a 401 carries a Bearer challenge", () => {
    expect(gcsError("json", "unauthenticated").headers.get("WWW-Authenticate")).toBe('Bearer realm="storage"');
  });
}
