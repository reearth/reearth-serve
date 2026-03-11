import type { Job } from "./model";

export interface JobStore {
  save(job: Job): Promise<void>;
  find(id: string): Promise<Job | null>;
  delete(id: string): Promise<void>;
}
