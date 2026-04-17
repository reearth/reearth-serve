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
  /**
   * Return jobs marked `completed` whose associated asset is still stuck
   * in `pending`/`extracting`. That drift happens when the internal
   * status callback successfully wrote the job row but then failed to
   * write the asset row (two separate D1 statements). Cron uses this to
   * self-heal so an extracted asset doesn't appear to be still
   * extracting indefinitely.
   */
  listStuckAssets?(limit: number): Promise<Job[]>;
}
