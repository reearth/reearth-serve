import { AwsClient } from "aws4fetch";
import type { UploadPart } from "../asset/model";
import type { PresignedUrlGenerator } from "../asset/repository";

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

  private objectUrl(key: string): URL {
    return new URL(`/${this.bucket}/${key}`, this.endpoint);
  }

  async generatePutUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

    const signed = await this.client.sign(
      new Request(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
      }),
      { aws: { signQuery: true } },
    );

    return signed.url;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploads", "");

    const res = await this.client.fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType },
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
