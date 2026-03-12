import type { FileStorage, MetadataStore, UploadSessionStore, PresignedUrlGenerator } from "./asset/repository";
import type { JobStore } from "./job/repository";
import type { AuthUser } from "./auth/types";
import type { Authorizer } from "./auth/authorizer";
import type { ProjectStore } from "./project/repository";

export type AppEnv = {
  Variables: {
    metadata: MetadataStore;
    storage: FileStorage;
    uploadSessions: UploadSessionStore;
    presignedUrls: PresignedUrlGenerator | null;
    jobs: JobStore;
    ttlSeconds: number;
    baseUrl: string;
    user: AuthUser | null;
    sessionId: string | null;
    authorizer: Authorizer;
    projects: ProjectStore;
  };
};
