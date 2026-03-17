import type { Job } from "./model";
import type { ListResult } from "../asset/repository";

export interface JobStore {
  save(job: Job): Promise<void>;
  find(id: string): Promise<Job | null>;
  delete(id: string): Promise<void>;
  list(options?: { limit?: number; cursor?: string; sessionId?: string; projectId?: string }): Promise<ListResult<Job>>;
  listRetriable?(stuckThresholdMs: number, maxRetries: number): Promise<Job[]>;
}
