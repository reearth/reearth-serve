import type { TableView } from "./views";
import type { DirectoryRefusal } from "./zip/directory";

export type Built = { ok: true; view: TableView; bytes: number } | { ok: false; reason: DirectoryRefusal };

/**
 * Concurrent cold requests for one archive share a single build; a build that
 * fails or refuses is not kept.
 */
export interface ArchiveCache {
  load(key: string, build: () => Promise<Built>): Promise<Built>;
  evict(key: string): void;
  distrust(key: string): void;
  distrusted(key: string): boolean;
}

const DEFAULT_ARCHIVE_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_DISTRUSTED = 1024;

export function createArchiveCache(maxBytes = DEFAULT_ARCHIVE_CACHE_BYTES): ArchiveCache {
  const entries = new Map<string, { view: TableView; bytes: number }>();
  const building = new Map<string, Promise<Built>>();
  const untrusted = new Set<string>();
  let total = 0;

  const evict = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    total -= entry.bytes;
  };

  return {
    evict,
    distrust(key) {
      untrusted.delete(key);
      untrusted.add(key);
      for (const oldest of untrusted) {
        if (untrusted.size <= MAX_DISTRUSTED) break;
        untrusted.delete(oldest);
      }
      building.delete(key);
      evict(key);
    },
    distrusted: (key) => untrusted.has(key),
    load(key, build) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return Promise.resolve({ ok: true, ...hit });
      }
      const pending = building.get(key);
      if (pending) return pending;

      const started = build().then((built) => {
        if (built.ok && built.bytes <= maxBytes && !(built.view.from === "index" && untrusted.has(key))) {
          entries.set(key, { view: built.view, bytes: built.bytes });
          total += built.bytes;
          for (const oldest of entries.keys()) {
            if (total <= maxBytes) break;
            evict(oldest);
          }
        }
        return built;
      });
      building.set(key, started);
      const forget = () => {
        if (building.get(key) === started) building.delete(key);
      };
      started.then(forget, forget);
      return started;
    },
  };
}
