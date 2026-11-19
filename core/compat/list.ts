export type ListQuery = {
  prefix: string;
  delimiter: "/" | null;
  /** Inclusive. */
  startOffset: string | null;
  /** Exclusive. */
  endOffset: string | null;
  pageToken: string | null;
  maxResults: number;
};

export const MAX_LIST_RESULTS = 1000;

export type ListedPage<T> = { objects: T[]; prefixes: string[]; nextPageToken: string | null };

/** Rows with key in [from, until), ascending by key, at most `limit`. */
export type KeyScan<T> = (from: string, until: string | null, limit: number) => Promise<T[]>;

type Cursor = { from: string; skip: string | null };

/** SQLite orders TEXT by UTF-8 bytes, which is code point order, not UTF-16 code unit order. */
export function compareKeys(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function prefixEnd(prefix: string): string | null {
  if (prefix === "") return null;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 || last === 0x7f) return null;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

function encodeToken(name: string, isPrefix: boolean): string {
  const bytes = new TextEncoder().encode(`${isPrefix ? "p" : "o"}:${name}`);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeToken(token: string): Cursor | null {
  let text: string;
  try {
    const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  const name = text.slice(2);
  if (text.startsWith("o:")) return { from: name, skip: name };
  if (text.startsWith("p:") && name.endsWith("/")) return { from: prefixEnd(name)!, skip: null };
  return null;
}

function maxKey(...keys: string[]): string {
  return keys.reduce((a, b) => (compareKeys(a, b) >= 0 ? a : b));
}

function minKey(...keys: (string | null)[]): string | null {
  const present = keys.filter((k): k is string => k !== null);
  return present.length === 0 ? null : present.reduce((a, b) => (compareKeys(a, b) <= 0 ? a : b));
}

export async function listPage<T extends { key: string }>(
  query: ListQuery,
  scan: KeyScan<T>,
  batch = MAX_LIST_RESULTS,
): Promise<ListedPage<T> | null> {
  const { prefix, delimiter, startOffset, endOffset, maxResults } = query;
  const resume = query.pageToken === null ? { from: "", skip: null } : decodeToken(query.pageToken);
  if (!resume) return null;
  const until = minKey(prefixEnd(prefix), endOffset);
  let from = maxKey(prefix, startOffset ?? "", resume.from);
  let skip = resume.skip;

  const objects: T[] = [];
  const prefixes: string[] = [];
  let lastPrefix: string | null = null;
  let last: { name: string; isPrefix: boolean } | null = null;
  let more = false;

  scanning: while (until === null || compareKeys(from, until) < 0) {
    const rows = await scan(from, until, batch);
    for (const row of rows) {
      const key = row.key;
      if (key === skip || !key.startsWith(prefix)) continue;
      const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
      const name = cut >= 0 ? key.slice(0, cut + 1) : key;
      if (cut >= 0 && name === lastPrefix) continue;
      if (objects.length + prefixes.length >= maxResults) {
        more = true;
        break scanning;
      }
      if (cut >= 0) {
        prefixes.push(name);
        lastPrefix = name;
      } else {
        objects.push(row);
      }
      last = { name, isPrefix: cut >= 0 };
    }
    if (rows.length < batch) break;
    const lastRow = rows[rows.length - 1].key;
    if (lastPrefix !== null && lastRow.startsWith(lastPrefix)) {
      from = prefixEnd(lastPrefix)!;
      skip = null;
    } else {
      from = lastRow;
      skip = lastRow;
    }
  }

  return { objects, prefixes, nextPageToken: more && last ? encodeToken(last.name, last.isPrefix) : null };
}
