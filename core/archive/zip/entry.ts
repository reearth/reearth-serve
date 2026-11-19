import type { FileStorage } from "../../asset/repository";
import type { TableEntry } from "../table";
import { crc32 } from "./directory";

const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER = 30;
const MAX_LOCAL_EXTRA = 0xffff;
const SINGLE_READ_DEPTH = 1 << 20;

export interface ArchiveObject {
  storage: FileStorage;
  key: string;
  /** Where the central directory starts, so where every entry's data must end. */
  dataEnd: number;
  etag: string | undefined;
}

export interface Span {
  offset: number;
  length: number;
}

export type EntryBytes =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; reason: "missing" | "changed" | "mismatch" | "corrupt" };

/** A local header's extra field has its own 16-bit length (APPNOTE.TXT 4.3.7), so up to 64 KiB of it may sit between the name and the data. */
export async function readEntryBytes(archive: ArchiveObject, entry: TableEntry, span: Span = { offset: 0, length: entry.compressedSize }): Promise<EntryBytes> {
  const headerEnd = LOCAL_HEADER + entry.cdNameLength;
  const fits = (extra: number) => entry.localHeaderOffset + headerEnd + extra + entry.compressedSize <= archive.dataEnd;
  if (!fits(0)) return { ok: false, reason: "corrupt" };
  if (span.offset > SINGLE_READ_DEPTH) {
    const probe = await fetchRange(archive, entry.localHeaderOffset, headerEnd);
    if (!probe.ok) return probe;
    const head = await take(probe.body, headerEnd);
    await probe.body.cancel().catch(() => {});
    const extra = head && localExtraLength(head, entry);
    if (extra === null) return { ok: false, reason: "mismatch" };
    if (!fits(extra)) return { ok: false, reason: "corrupt" };
    const data = await fetchRange(archive, entry.localHeaderOffset + headerEnd + extra + span.offset, span.length);
    if (!data.ok) return data;
    return { ok: true, body: exactly(data.body, 0, span.length) };
  }

  const read = await fetchRange(archive, entry.localHeaderOffset, headerEnd + MAX_LOCAL_EXTRA + span.offset + span.length);
  if (!read.ok) return read;
  const reader = read.body.getReader();
  const head = await takeFrom(reader, headerEnd);
  const extra = head && localExtraLength(head.bytes, entry);
  if (!head || extra === null || !fits(extra)) {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: head && extra !== null ? "corrupt" : "mismatch" };
  }
  return { ok: true, body: exactly(resume(reader, head.rest), extra + span.offset, span.length) };
}

async function fetchRange(archive: ArchiveObject, offset: number, length: number): Promise<EntryBytes> {
  const capped = Math.min(length, archive.dataEnd - offset);
  if (capped <= 0) return { ok: false, reason: "mismatch" };
  const file = await archive.storage.get(archive.key, { offset, length: capped });
  if (!file) return { ok: false, reason: "missing" };
  if (archive.etag && file.etag && file.etag !== archive.etag) {
    await file.body.cancel().catch(() => {});
    return { ok: false, reason: "changed" };
  }
  return { ok: true, body: file.body };
}

function localExtraLength(head: Uint8Array, entry: TableEntry): number | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== LOCAL_SIGNATURE) return null;
  if (view.getUint16(8, true) !== entry.method) return null;
  if (view.getUint16(26, true) !== entry.cdNameLength) return null;
  if (crc32(head.subarray(LOCAL_HEADER)) !== entry.cdNameCrc) return null;
  return view.getUint16(28, true);
}

async function take(body: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const head = await takeFrom(reader, length);
  reader.releaseLock();
  return head?.bytes ?? null;
}

async function takeFrom(reader: ReadableStreamDefaultReader<Uint8Array>, length: number): Promise<{ bytes: Uint8Array; rest: Uint8Array } | null> {
  const parts: Uint8Array[] = [];
  let have = 0;
  while (have < length) {
    const { done, value } = await reader.read();
    if (done) return null;
    parts.push(value);
    have += value.byteLength;
  }
  const all = parts.length === 1 ? parts[0] : concat(parts, have);
  return { bytes: all.subarray(0, length), rest: all.subarray(length) };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function resume(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array): ReadableStream<Uint8Array> {
  let pending: Uint8Array | null = first.byteLength > 0 ? first : null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function exactly(source: ReadableStream<Uint8Array>, skip: number, length: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let skipped = 0;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (sent < length) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error(`zip entry ended ${length - sent} bytes short`));
          return;
        }
        const drop = Math.min(skip - skipped, value.byteLength);
        skipped += drop;
        const chunk = value.subarray(drop, drop + length - sent);
        if (chunk.byteLength === 0) continue;
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent < length) return;
      }
      controller.close();
      await reader.cancel().catch(() => {});
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
