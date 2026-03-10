import type { AssetMetadata, UploadSession } from "../asset/model";
import type { MetadataStore, UploadSessionStore } from "../asset/repository";

export class KVMetadataStore implements MetadataStore {
  constructor(private kv: KVNamespace) {}

  async save(asset: AssetMetadata, ttlSeconds: number): Promise<void> {
    await this.kv.put(`asset:${asset.id}`, JSON.stringify(asset), {
      expirationTtl: ttlSeconds,
    });
  }

  async find(id: string): Promise<AssetMetadata | null> {
    const raw = await this.kv.get(`asset:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as AssetMetadata;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`asset:${id}`);
  }
}

export class KVUploadSessionStore implements UploadSessionStore {
  constructor(private kv: KVNamespace) {}

  async save(session: UploadSession, ttlSeconds: number): Promise<void> {
    await this.kv.put(`upload:${session.id}`, JSON.stringify(session), {
      expirationTtl: ttlSeconds,
    });
  }

  async find(id: string): Promise<UploadSession | null> {
    const raw = await this.kv.get(`upload:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as UploadSession;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`upload:${id}`);
  }
}
