import type { FileStorage, MetadataStore } from "./asset/repository";

export type AppEnv = {
  Variables: {
    metadata: MetadataStore;
    storage: FileStorage;
    ttlSeconds: number;
    baseUrl: string;
  };
};
