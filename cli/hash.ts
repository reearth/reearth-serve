import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** SHA-256 of zero bytes. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** SHA-256 of bytes already in memory, lowercase hex. */
export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash a file by streaming it, so a file of any size (hundreds of GiB) is
 * hashed in constant memory. `onProgress` gets the bytes read so far.
 */
export async function hashFile(
  path: string,
  algorithm: "sha256" | "md5",
  onProgress?: (bytesRead: number) => void,
): Promise<string> {
  const hash = createHash(algorithm);
  let read = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).byteLength;
    onProgress?.(read);
  }
  return hash.digest("hex");
}

export function sha256File(path: string, onProgress?: (bytesRead: number) => void): Promise<string> {
  return hashFile(path, "sha256", onProgress);
}

/** The `md5:<hex>` form the file listing's `hash` uses. */
export async function md5File(path: string): Promise<string> {
  return `md5:${await hashFile(path, "md5")}`;
}

/**
 * A progress line on stderr for a long pass over a file, redrawn at most
 * every half second. `done()` ends the line.
 */
export function progressLine(label: string, total: number, format: (n: number) => string): {
  update: (n: number) => void;
  done: () => void;
} {
  let last = 0;
  const draw = (n: number) => {
    const pct = total > 0 ? Math.floor((n / total) * 100) : 100;
    process.stderr.write(`\r${label} ${format(n)} / ${format(total)} (${pct}%)`);
  };
  return {
    update(n) {
      const now = Date.now();
      if (now - last < 500 && n < total) return;
      last = now;
      draw(n);
    },
    done() {
      draw(total);
      process.stderr.write("\n");
    },
  };
}
