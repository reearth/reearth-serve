// Re-export shared API types
export type { Job } from "../../shared/api";

// Worker-only types

export interface FileEntry {
  path: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
}
