export interface SyntheticEntry {
  name: string;
  data: Uint8Array;
  commentPadding?: number;
  method?: number;
  flags?: number;
  compressed?: Uint8Array;
  localExtra?: Uint8Array;
}

const encoder = new TextEncoder();

export function writeZip(entries: SyntheticEntry[]): Uint8Array {
  const zip64 = entries.length >= 0xffff;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const payload = entry.compressed ?? entry.data;
    const extra = entry.localExtra ?? new Uint8Array(0);
    const local = new Uint8Array(30 + name.byteLength + extra.byteLength + payload.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, entry.method ?? 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.byteLength, true);
    lv.setUint32(22, entry.data.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, extra.byteLength, true);
    local.set(name, 30);
    local.set(extra, 30 + name.byteLength);
    local.set(payload, 30 + name.byteLength + extra.byteLength);
    locals.push(local);

    const comment = entry.commentPadding ?? 0;
    const central = new Uint8Array(46 + name.byteLength + comment);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, entry.flags ?? 0, true);
    cv.setUint16(10, entry.method ?? 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.byteLength, true);
    cv.setUint32(24, entry.data.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint16(32, comment, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }

  const cdOffset = offset;
  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const tail: Uint8Array[] = [];
  if (zip64) {
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, 44n, true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(entries.length), true);
    record.setBigUint64(32, BigInt(entries.length), true);
    record.setBigUint64(40, BigInt(cdSize), true);
    record.setBigUint64(48, BigInt(cdOffset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(cdOffset + cdSize), true);
    locator.setUint32(16, 1, true);
    tail.push(new Uint8Array(record.buffer), new Uint8Array(locator.buffer));
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, zip64 ? 0xffff : entries.length, true);
  eocd.setUint16(10, zip64 ? 0xffff : entries.length, true);
  eocd.setUint32(12, zip64 ? 0xffffffff : cdSize, true);
  eocd.setUint32(16, zip64 ? 0xffffffff : cdOffset, true);
  tail.push(new Uint8Array(eocd.buffer));

  const parts = [...locals, ...centrals, ...tail];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
