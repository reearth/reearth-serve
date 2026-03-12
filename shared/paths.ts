export const API_V1 = "/api/v1" as const;
export const API_INTERNAL = "/api/internal" as const;

export const PATHS = {
  health: `${API_V1}/health`,
  assets: `${API_V1}/assets`,
  asset: (id: string) => `${API_V1}/assets/${id}`,
  uploads: `${API_V1}/assets/uploads`,
  completeUpload: (id: string) => `${API_V1}/assets/uploads/${id}/complete`,
  jobs: `${API_V1}/jobs`,
  job: (id: string) => `${API_V1}/jobs/${id}`,
  jobRetry: (id: string) => `${API_V1}/jobs/${id}/retry`,
  jobStatus: (id: string) => `${API_INTERNAL}/jobs/${id}/status`,
  file: (id: string, filename: string) => `/files/${id}/${encodeURIComponent(filename)}`,
} as const;
