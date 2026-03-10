import type { FileStorage, MetadataStore, UploadSessionStore, PresignedUrlGenerator } from "./asset/repository";

export type AppEnv = {
  Variables: {
    metadata: MetadataStore;
    storage: FileStorage;
    uploadSessions: UploadSessionStore;
    presignedUrls: PresignedUrlGenerator | null;
    ttlSeconds: number;
    baseUrl: string;
  };
};
