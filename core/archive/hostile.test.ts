import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { createArchiveCache, openArchive, type ArchiveSource } from "./index";
import { buildView } from "./reader";

const enc = new TextEncoder();

interface RawEntry {
  name: Uint8Array;
  data?: Uint8Array;
}

/** A stored zip from raw name bytes, with an optional archive comment and a recorded entry count that may lie. */
function zipRaw(entries: RawEntry[], options: { comment?: Uint8Array; recordedCount?: number } = {}): Uint8Array {
  const comment = options.comment ?? new Uint8Array(0);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0);
    const local = new Uint8Array(30 + e.name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, data.byteLength, true);
    lv.setUint16(26, e.name.byteLength, true);
    local.set(e.name, 30);
    local.set(data, 30 + e.name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + e.name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, data.byteLength, true);
    cv.setUint16(28, e.name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(e.name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }
  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22 + comment.byteLength);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.recordedCount ?? entries.length, true);
  ev.setUint16(10, options.recordedCount ?? entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.byteLength, true);
  eocd.set(comment, 22);
  return concat([...locals, ...centrals, eocd]);
}

/** Rewrite a plain zip as zip64 whose record claims `recordedCount` entries. */
function asZip64(base: Uint8Array, recordedCount: bigint): Uint8Array {
  const eocdAt = base.byteLength - 22;
  const bv = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const head = base.subarray(0, eocdAt);
  const record = new DataView(new ArrayBuffer(56));
  record.setUint32(0, 0x06064b50, true);
  record.setBigUint64(4, 44n, true);
  record.setBigUint64(24, recordedCount, true);
  record.setBigUint64(32, recordedCount, true);
  record.setBigUint64(40, BigInt(bv.getUint32(eocdAt + 12, true)), true);
  record.setBigUint64(48, BigInt(bv.getUint32(eocdAt + 16, true)), true);
  const locator = new DataView(new ArrayBuffer(20));
  locator.setUint32(0, 0x07064b50, true);
  locator.setBigUint64(8, BigInt(head.byteLength), true);
  locator.setUint32(16, 1, true);
  const eocd = base.slice(eocdAt);
  const ev = new DataView(eocd.buffer);
  ev.setUint16(8, 0xffff, true);
  ev.setUint16(10, 0xffff, true);
  ev.setUint32(12, 0xffffffff, true);
  ev.setUint32(16, 0xffffffff, true);
  return concat([head, new Uint8Array(record.buffer), new Uint8Array(locator.buffer), eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function stored(bytes: Uint8Array) {
  const storage = new MemoryFileStorage();
  const source: ArchiveSource = { key: "assets/x/a.zip", size: bytes.byteLength, filename: "a.zip" };
  await storage.put(source.key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  return { storage, source };
}

async function open(bytes: Uint8Array) {
  const { storage, source } = await stored(bytes);
  return openArchive({ storage, archives: createArchiveCache() }, source);
}

async function listNames(bytes: Uint8Array): Promise<string[]> {
  const opened = await open(bytes);
  if (!opened.ok) throw new Error(`refused: ${opened.reason}`);
  return (await opened.reader.list({ limit: 10_000 })).entries.map((e) => e.path);
}

const fakeEocd = () => {
  const fake = new Uint8Array(22);
  new DataView(fake.buffer).setUint32(0, 0x06054b50, true);
  return fake;
};

describe("hostile end records answer what Go's archive/zip answers", () => {
  test("an archive comment ending in an empty EOCD lists nothing, as the extractor extracts nothing", async () => {
    const bytes = zipRaw([{ name: enc.encode("a.txt"), data: enc.encode("hello") }], { comment: fakeEocd() });
    expect(await listNames(bytes)).toEqual([]);
  });

  test("a last EOCD whose comment runs past the end of the file is not a zip", async () => {
    const truncated = new Uint8Array(30);
    const tv = new DataView(truncated.buffer);
    tv.setUint32(0, 0x06054b50, true);
    tv.setUint16(20, 100, true);
    const bytes = zipRaw([{ name: enc.encode("a.txt"), data: enc.encode("hello") }], { comment: truncated });
    expect(await open(bytes)).toEqual({ ok: false, reason: "not-zip" });
  });

  test("an EOCD whose entry count disagrees with the directory is refused as corrupt", async () => {
    const bytes = zipRaw(
      [
        { name: enc.encode("a.txt"), data: enc.encode("1") },
        { name: enc.encode("b.txt"), data: enc.encode("2") },
      ],
      { recordedCount: 5 },
    );
    expect(await open(bytes)).toEqual({ ok: false, reason: "corrupt" });
  });

  test.each([2n ** 40n, 2n ** 60n, 30_000_000n])("a zip64 record claiming %s entries over one record is refused, not thrown", async (claim) => {
    const bytes = asZip64(zipRaw([{ name: enc.encode("a.txt"), data: enc.encode("1") }]), claim);
    expect(await open(bytes)).toEqual({ ok: false, reason: "corrupt" });
  });

  test("a count that only agrees modulo 65,536 opens, reports the records it holds, and sizes nothing from the claim", async () => {
    const bytes = asZip64(zipRaw([{ name: enc.encode("a.txt"), data: enc.encode("1") }]), 65_537n);
    const original = globalThis.ArrayBuffer;
    let largest = 0;
    globalThis.ArrayBuffer = new Proxy(original, {
      construct(target, args) {
        largest = Math.max(largest, Number(args[0] ?? 0));
        return Reflect.construct(target, args);
      },
    });
    let opened;
    try {
      opened = await open(bytes);
    } finally {
      globalThis.ArrayBuffer = original;
    }
    if (!opened.ok) throw new Error(`refused: ${opened.reason}`);
    expect(opened.reader.entryCount).toBe(1);
    expect(largest).toBeLessThan(1 << 20);
  });
});

describe("a name whose UTF-8 form outgrows 65,535 bytes", () => {
  const bytes = () => zipRaw([{ name: new Uint8Array(25_000).fill(0xb0) }, { name: enc.encode("ok.txt") }]);

  test("is listed", async () => {
    const names = await listNames(bytes());
    expect(names.map((n) => n.length).sort()).toEqual([6, 25_000]);
  });

  test("is listed the same by the scan view and the memory view", async () => {
    const { storage, source } = await stored(bytes());
    const memory = await buildView(storage, source, () => {});
    const scan = await buildView(storage, source, () => {}, 0);
    if (!memory.ok || !scan.ok) throw new Error("refused");
    const list = async (built: typeof memory) =>
      built.ok && (await built.view.list({ prefix: "", delimiter: "", after: "", limit: 10_000 })).entries.map((e) => e.path);
    expect(await list(scan)).toEqual(await list(memory));
    const found = await memory.view.find("░".repeat(25_000));
    expect(found?.path.length).toBe(25_000);
  });
});
