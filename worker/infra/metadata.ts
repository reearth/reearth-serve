import type { AssetMetadata } from "../asset/model";
import type { MetadataStore } from "../asset/repository";

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
