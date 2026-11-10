import type { ErrorCode } from "../../../shared/api";
import { ChecksumMismatchError, UPLOAD_UNDER_VERIFICATION_MESSAGE, UploadUnderVerificationError } from "../integrity";
import { BLOB_UNAVAILABLE_MESSAGE, BlobUnavailableError } from "../../blob/usecase";

export const CHECKSUM_MISMATCH_MESSAGE = "Declared SHA-256 does not match the uploaded bytes; nothing was stored";

/**
 * The response for an upload error a client acts on (ADR-017 P5): a status, a
 * message for people, and a stable `code` for programs. `undefined` for any
 * other error, which the route handles (or rethrows) itself.
 *
 * One place for the upload routes so the same error never gets two codes. The
 * code is what the CLI branches on — retry or wait — so the message can be
 * reworded without breaking it.
 */
export function uploadErrorResponse(
  e: unknown,
): { status: 409 | 422; body: { error: string; code: ErrorCode } } | undefined {
  if (e instanceof ChecksumMismatchError) {
    return { status: 422, body: { error: CHECKSUM_MISMATCH_MESSAGE, code: "checksum_mismatch" } };
  }
  if (e instanceof UploadUnderVerificationError) {
    return { status: 409, body: { error: UPLOAD_UNDER_VERIFICATION_MESSAGE, code: "upload_under_verification" } };
  }
  if (e instanceof BlobUnavailableError) {
    return { status: 409, body: { error: BLOB_UNAVAILABLE_MESSAGE, code: "blob_unavailable" } };
  }
  return undefined;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("each upload error has its own status and code", () => {
    expect(uploadErrorResponse(new ChecksumMismatchError("a".repeat(64)))).toEqual({
      status: 422, body: { error: CHECKSUM_MISMATCH_MESSAGE, code: "checksum_mismatch" },
    });
    expect(uploadErrorResponse(new UploadUnderVerificationError("a1"))?.body.code).toBe("upload_under_verification");
    expect(uploadErrorResponse(new BlobUnavailableError("blobs/ws/x"))).toMatchObject({ status: 409, body: { code: "blob_unavailable" } });
  });

  test("other errors are left to the route", () => {
    expect(uploadErrorResponse(new Error("exceeds storage capacity"))).toBeUndefined();
    expect(uploadErrorResponse("boom")).toBeUndefined();
  });

  test("every code the mapper emits is in the published ErrorCode enum", async () => {
    const { errorCodeSchema } = await import("../../../shared/api");
    const codes = [
      new ChecksumMismatchError("a".repeat(64)), new UploadUnderVerificationError("a1"),
      new BlobUnavailableError("k"),
    ].map((e) => uploadErrorResponse(e)!.body.code);
    for (const code of codes) expect(errorCodeSchema.options).toContain(code);
  });
}
