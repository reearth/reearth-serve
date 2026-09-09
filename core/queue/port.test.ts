import { describe, expect, test, vi } from "vitest";

// The in-Worker generator pulls in @jsquash's wasm codecs, which cannot load
// in the plain node vitest environment. The consumer tests below only exercise
// the container path, so the codec module is replaced wholesale.
vi.mock("../thumbnail/generator", () => ({
  generateThumbnails: async () => {
    throw new Error("in-Worker generation is not exercised here");
  },
}));

import { MemoryJobQueue } from "../../adapters/memory/memory-queue";
import { CloudflareJobQueue, toQueueMessages } from "../../adapters/cloudflare/queues";
import { handleQueue, type ExtractionMessage } from "../extraction/handler";
import { handleThumbnailQueue } from "../thumbnail/handler";
import { enqueueThumbnail, type ThumbnailMessage } from "../thumbnail/queue";
import { retryDelaySeconds } from "../extraction/backoff";
import type { Deps } from "../types";
import type { ContainerLauncher } from "../container/port";
import type { Job } from "../job/model";

// The consumers below only ever touch `containers`, `jobs` and `storage`;
// everything else stays absent on purpose, so a handler that starts reaching
// for another dependency fails here instead of in production.
function deps(partial: Partial<Deps>): Deps {
  return partial as Deps;
}

function launcher(overrides: Partial<ContainerLauncher> = {}): ContainerLauncher {
  return {
    archiveExtractorAvailable: true,
    launchArchiveExtractor: async () => {},
    generateThumbnails: async () => {},
    ...overrides,
  };
}

const extraction: ExtractionMessage = {
  assetId: "a1",
  archiveKey: "assets/a1/x.zip",
  archiveFilename: "x.zip",
  archiveFormat: "zip",
};

describe("MemoryJobQueue", () => {
  test("delivers what was sent, once", async () => {
    const queue = new MemoryJobQueue<ExtractionMessage>();
    await queue.send(extraction);

    const first = queue.receive();
    expect(first.map((m) => m.body)).toEqual([extraction]);
    expect(first[0].attempts).toBe(1);

    first[0].ack();
    expect(queue.receive()).toEqual([]);
    expect(queue.size).toBe(0);
  });

  test("a delayed send stays invisible until the clock passes it", async () => {
    let now = 1_000;
    const queue = new MemoryJobQueue<ExtractionMessage>({ now: () => now });

    await queue.send(extraction, { delaySeconds: 30 });
    expect(queue.receive()).toEqual([]);
    expect(queue.size).toBe(1);

    now += 29_999;
    expect(queue.receive()).toEqual([]);

    now += 1;
    expect(queue.receive()).toHaveLength(1);
  });

  test("retry redelivers with the delay applied and the attempt count raised", async () => {
    let now = 0;
    const queue = new MemoryJobQueue<ExtractionMessage>({ now: () => now });
    await queue.send(extraction);

    queue.receive()[0].retry({ delaySeconds: 10 });
    expect(queue.receive()).toEqual([]);

    now += 10_000;
    const redelivered = queue.receive();
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0].attempts).toBe(2);
  });

  test("a message that exhausts its attempts is dead-lettered instead of looping", async () => {
    const queue = new MemoryJobQueue<ExtractionMessage>({ maxAttempts: 3 });
    await queue.send(extraction);

    for (let i = 1; i <= 3; i++) {
      const messages = queue.receive();
      expect(messages).toHaveLength(1);
      expect(messages[0].attempts).toBe(i);
      messages[0].retry();
    }

    expect(queue.receive()).toEqual([]);
    expect(queue.dead).toEqual([extraction]);
  });

  test("settling a message twice is a programming error", async () => {
    const queue = new MemoryJobQueue<ExtractionMessage>();
    await queue.send(extraction);
    const message = queue.receive()[0];
    message.ack();
    expect(() => message.retry()).toThrow(/settled twice/);
  });
});

describe("Cloudflare adapter", () => {
  test("send forwards delaySeconds and omits the options object without one", async () => {
    const calls: unknown[][] = [];
    const queue = new CloudflareJobQueue<ExtractionMessage>({
      send: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as Queue<ExtractionMessage>);

    await queue.send(extraction);
    await queue.send(extraction, { delaySeconds: 300 });

    expect(calls).toEqual([
      [extraction, undefined],
      [extraction, { delaySeconds: 300 }],
    ]);
  });

  test("toQueueMessages carries attempts and forwards ack/retry per message", () => {
    const acked: string[] = [];
    const retried: { id: string; options?: { delaySeconds?: number } }[] = [];
    const batch = {
      messages: [
        { body: extraction, attempts: 3, ack: () => acked.push("m1"), retry: (o?: { delaySeconds?: number }) => retried.push({ id: "m1", options: o }) },
        { body: extraction, attempts: 1, ack: () => acked.push("m2"), retry: (o?: { delaySeconds?: number }) => retried.push({ id: "m2", options: o }) },
      ],
    } as unknown as MessageBatch<ExtractionMessage>;

    const messages = toQueueMessages(batch);
    expect(messages.map((m) => m.attempts)).toEqual([3, 1]);
    messages[0].ack();
    messages[1].retry({ delaySeconds: 60 });

    expect(acked).toEqual(["m1"]);
    expect(retried).toEqual([{ id: "m2", options: { delaySeconds: 60 } }]);
  });
});

describe("enqueueThumbnail over a JobQueue", () => {
  const thumbnail: ThumbnailMessage = {
    assetId: "a1",
    sourceKey: "assets/a1/p.png",
    contentType: "image/png",
    size: 1234,
  };

  test("sends thumbnailable content", async () => {
    const queue = new MemoryJobQueue<ThumbnailMessage>();
    await enqueueThumbnail(queue, thumbnail);
    expect(queue.bodies).toEqual([thumbnail]);
  });

  test("skips non-thumbnailable content and a missing queue", async () => {
    const queue = new MemoryJobQueue<ThumbnailMessage>();
    await enqueueThumbnail(queue, { ...thumbnail, contentType: "application/zip" });
    expect(queue.bodies).toEqual([]);
    await expect(enqueueThumbnail(null, thumbnail)).resolves.toBeUndefined();
  });
});

describe("handleQueue (extraction consumer)", () => {
  test("acks a message whose extractor launched", async () => {
    const queue = new MemoryJobQueue<ExtractionMessage>();
    await queue.send(extraction);
    const launched: ExtractionMessage[] = [];

    await handleQueue(
      queue.receive(),
      deps({
        containers: launcher({
          launchArchiveExtractor: async (params) => {
            launched.push(params as ExtractionMessage);
          },
        }),
      }),
    );

    expect(launched).toHaveLength(1);
    expect(queue.receive()).toEqual([]);
    expect(queue.size).toBe(0);
  });

  test("retries with the backoff schedule and touches the pending job", async () => {
    let now = 0;
    const queue = new MemoryJobQueue<ExtractionMessage>({ now: () => now });
    await queue.send(extraction);

    const job = { id: "j1", assetId: "a1", status: "pending", updatedAt: 0 } as Job;
    const saved: Job[] = [];
    const failing = deps({
      containers: launcher({
        launchArchiveExtractor: async () => {
          throw new Error("no capacity");
        },
      }),
      jobs: {
        find: async () => job,
        save: async (j: Job) => {
          saved.push(j);
        },
      } as unknown as Deps["jobs"],
    });

    vi.spyOn(console, "error").mockImplementation(() => {});

    // Two consecutive failures: each retry must land exactly on the backoff
    // delay for the attempt that failed.
    for (const attempt of [1, 2]) {
      const delivered = queue.receive();
      expect(delivered).toHaveLength(1);
      expect(delivered[0].attempts).toBe(attempt);

      await handleQueue(delivered, failing);

      now += retryDelaySeconds(attempt) * 1000 - 1;
      expect(queue.receive()).toEqual([]); // still invisible one ms early
      now += 1;
    }

    expect(saved).toHaveLength(2);
    expect(saved.every((j) => j.updatedAt > 0)).toBe(true);

    vi.restoreAllMocks();
  });

  test("retries every message when the extractor is not configured at all", async () => {
    let now = 0;
    const queue = new MemoryJobQueue<ExtractionMessage>({ now: () => now });
    await queue.send(extraction);
    await queue.send({ ...extraction, assetId: "a2" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueue(
      queue.receive(),
      deps({ containers: launcher({ archiveExtractorAvailable: false }) }),
    );

    // Nothing launched, nothing acked, and the whole batch is held for the
    // misconfiguration delay rather than burning its retry budget at once.
    expect(queue.receive()).toEqual([]);
    now += 300_000;
    expect(queue.receive()).toHaveLength(2);

    vi.restoreAllMocks();
  });
});

describe("handleThumbnailQueue (thumbnail consumer)", () => {
  const big: ThumbnailMessage = {
    assetId: "a1",
    versionId: "v1",
    sourceKey: "assets/a1/big.png",
    contentType: "image/png",
    size: 64 * 1024 * 1024,
  };

  test("acks after the container generated the thumbnails", async () => {
    const queue = new MemoryJobQueue<ThumbnailMessage>();
    await queue.send(big);
    const calls: unknown[] = [];

    await handleThumbnailQueue(
      queue.receive(),
      deps({
        containers: launcher({
          generateThumbnails: async (params) => {
            calls.push(params);
          },
        }),
      }),
    );

    expect(calls).toEqual([
      { assetId: "a1", versionId: "v1", sourceKey: big.sourceKey, contentType: "image/png" },
    ]);
    expect(queue.size).toBe(0);
  });

  test("retries the failing message without delay", async () => {
    const queue = new MemoryJobQueue<ThumbnailMessage>();
    await queue.send(big);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handleThumbnailQueue(
      queue.receive(),
      deps({
        containers: launcher({
          generateThumbnails: async () => {
            throw new Error("container unavailable");
          },
        }),
      }),
    );

    const redelivered = queue.receive();
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0].attempts).toBe(2);

    vi.restoreAllMocks();
  });
});
