import { AwsClient } from "aws4fetch";
import type { UploadPart } from "../../core/asset/model";
import type { PresignedPut, PresignedUrlGenerator } from "../../core/asset/repository";
import { sha256HexToBase64 } from "../../core/asset/integrity";

export class R2PresignedUrlGenerator implements PresignedUrlGenerator {
  private client: AwsClient;
  private endpoint: string;
  private bucket: string;

  constructor(config: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  }) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.endpoint = config.endpoint;
    this.bucket = config.bucket;
  }

  // Each key segment is percent-encoded so the URL parser cannot reinterpret
  // it: `%2e%2e` would otherwise resolve as `..`, and `?` or `#` would cut the
  // key short. aws4fetch decodes the path once before signing, so the signed
  // canonical path still names the literal key.
  private objectUrl(key: string): URL {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return new URL(`/${this.bucket}/${path}`, this.endpoint);
  }

  /**
   * A declared SHA-256 (ADR-017 §2) is bound into the signature as the
   * `x-amz-checksum-sha256` header (base64 of the digest). It is listed in
   * `X-Amz-SignedHeaders`, so the client must send it verbatim — omitting or
   * altering it fails the signature — and the store checks the body against it
   * on write. The header is returned for the session response to hand on.
   */
  async generatePutUrl(key: string, contentType: string, expiresInSeconds: number, options?: { contentEncoding?: string; sha256?: string }): Promise<PresignedPut> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

    const headers: Record<string, string> = { "Content-Type": contentType };
    if (options?.contentEncoding) {
      headers["Content-Encoding"] = options.contentEncoding;
    }
    const extra: Record<string, string> = {};
    if (options?.sha256) {
      extra["x-amz-checksum-sha256"] = sha256HexToBase64(options.sha256);
    }

    const signed = await this.client.sign(
      new Request(url, { method: "PUT", headers: { ...headers, ...extra } }),
      { aws: { signQuery: true } },
    );

    return { url: signed.url, headers: extra };
  }

  async createMultipartUpload(key: string, contentType: string, options?: { contentEncoding?: string }): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploads", "");

    const headers: Record<string, string> = { "Content-Type": contentType };
    if (options?.contentEncoding) {
      headers["Content-Encoding"] = options.contentEncoding;
    }

    const res = await this.client.fetch(url, {
      method: "POST",
      headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CreateMultipartUpload failed (${res.status}): ${body}`);
    }

    const xml = await res.text();
    const match = xml.match(/<UploadId>(.+?)<\/UploadId>/);
    if (!match) throw new Error("Failed to parse UploadId from CreateMultipartUpload response");

    return match[1];
  }

  async generateUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

    const signed = await this.client.sign(
      new Request(url, { method: "PUT" }),
      { aws: { signQuery: true } },
    );

    return signed.url;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploadId", uploadId);

    const xmlParts = parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("");
    const body = `<CompleteMultipartUpload>${xmlParts}</CompleteMultipartUpload>`;

    const res = await this.client.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CompleteMultipartUpload failed (${res.status}): ${text}`);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploadId", uploadId);

    const res = await this.client.fetch(url, { method: "DELETE" });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AbortMultipartUpload failed (${res.status}): ${text}`);
    }
  }
}
