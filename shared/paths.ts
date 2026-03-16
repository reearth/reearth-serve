export const API_V1 = "/api/v1" as const;
export const API_INTERNAL = "/api/internal" as const;

export const PATHS = {
  health: `${API_V1}/health`,
  assets: `${API_V1}/assets`,
  asset: (id: string) => `${API_V1}/assets/${id}`,
  uploads: `${API_V1}/assets/uploads`,
  completeUpload: (id: string) => `${API_V1}/assets/uploads/${id}/complete`,
  assetExtract: (id: string) => `${API_V1}/assets/${id}/extract`,
  assetFiles: (id: string, prefix?: string) =>
    `${API_V1}/assets/${id}/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`,
  jobs: `${API_V1}/jobs`,
  job: (id: string) => `${API_V1}/jobs/${id}`,
  jobRetry: (id: string) => `${API_V1}/jobs/${id}/retry`,
  jobStatus: (id: string) => `${API_INTERNAL}/jobs/${id}/status`,
  me: `${API_V1}/me`,
  projects: `${API_V1}/projects`,
  project: (id: string) => `${API_V1}/projects/${id}`,
  workspaces: `${API_V1}/workspaces`,
  workspace: (id: string) => `${API_V1}/workspaces/${id}`,
  workspaceMembers: (id: string) => `${API_V1}/workspaces/${id}/members`,
  workspaceMember: (wsId: string, userId: string) => `${API_V1}/workspaces/${wsId}/members/${userId}`,
  file: (id: string, filename: string) => `/files/${id}/${encodeURIComponent(filename)}`,
} as const;
