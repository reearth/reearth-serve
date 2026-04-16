import type { Job } from "./model";
import type { ListResult } from "../asset/repository";

export interface JobStore {
  save(job: Job): Promise<void>;
  find(id: string): Promise<Job | null>;
  delete(id: string): Promise<void>;
  // Same scoping rules as MetadataStore.list — see that docstring.
  list(options?: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    projectId?: string;
    workspaceId?: string;
    accessibleByUser?: string;
  }): Promise<ListResult<Job>>;
  listRetriable?(stuckThresholdMs: number, maxRetries: number, limit?: number): Promise<Job[]>;
}
