// Kept separate from handler.ts: that module imports the container launcher,
// whose @cloudflare/containers dependency (`cloudflare:workers`) cannot load
// in the plain vitest unit environment — in-source tests must live here.

// Backoff for failed container launches, most commonly capacity exhaustion
// (max_instances or the account vCPU budget). Capacity frees up when a
// running extraction finishes — minutes to hours — so immediate redelivery
// would burn the queue's max_retries within seconds and dead-letter the job.
// The cap stays under the cleanup cron's 30-minute stuck threshold so the
// touch in handleQueue keeps sliding the cron's clock while the queue is
// still actively retrying.
export function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(attempts - 1, 0), 1200);
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("retryDelaySeconds backs off exponentially and caps under the cron threshold", () => {
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(2)).toBe(120);
    expect(retryDelaySeconds(3)).toBe(240);
    expect(retryDelaySeconds(5)).toBe(960);
    expect(retryDelaySeconds(6)).toBe(1200); // capped
    expect(retryDelaySeconds(20)).toBe(1200);
    expect(retryDelaySeconds(0)).toBe(60); // defensive: attempts should be >= 1
  });
}
