export interface Job {
  id: string;
  assetId: string;
  type: "archive-extraction";
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  fileCount?: number;
  extractedSize?: number;
}

export interface FileEntry {
  path: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
}
