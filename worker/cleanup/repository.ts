export interface PendingCleanup {
  prefix: string;
  createdAt: number;
}

/**
 * Records R2 prefixes whose synchronous deletion (e.g. DELETE /assets/:id)
 * couldn't be completed within the HTTP request's subrequest budget. The
 * scheduled worker drains these entries over subsequent ticks.
 */
export interface CleanupPendingStore {
  add(prefix: string): Promise<void>;
  list(limit: number): Promise<PendingCleanup[]>;
  remove(prefix: string): Promise<void>;
}
