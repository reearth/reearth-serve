// The Cloudflare Queues adapter: the only place `Queue` and `MessageBatch`
// appear in a test. The port-level behaviour it feeds lives in
// `core/queue/port.test.ts`, which must stay free of Workers types.
import { describe, expect, test } from "vitest";
import { CloudflareJobQueue, toQueueMessages } from "./queues";
import type { ExtractionMessage } from "../../core/extraction/handler";

const extraction: ExtractionMessage = {
  assetId: "a1",
  archiveKey: "assets/a1/x.zip",
  archiveFilename: "x.zip",
  archiveFormat: "zip",
};

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
