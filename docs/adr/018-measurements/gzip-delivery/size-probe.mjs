import fs from "node:fs";
import zlib from "node:zlib";
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  const single = zlib.deflateRawSync(buf, { level: 6 }).length;
  const row = { file: f.split("/").pop(), plain: buf.length, single };
  for (const seg of [65536, 262144, 1048576]) {
    let total = 0;
    for (let o = 0; o < buf.length; o += seg) total += zlib.deflateRawSync(buf.subarray(o, o + seg), { level: 6, finishFlush: zlib.constants.Z_FULL_FLUSH }).length;
    row[`ff${seg >> 10}k`] = `${total} (${((total / single - 1) * 100).toFixed(2)}%)`;
  }
  console.log(JSON.stringify(row));
}
