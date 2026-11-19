const UTF8_FLAG = 0x0800;
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const ROOT_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tgz", ".zip", ".tar"];

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const strictShiftJis = new TextDecoder("shift_jis", { fatal: true });

export type LegacyEncoding = "shift_jis" | "cp437";

export type RecordName =
  | { kind: "utf8"; name: string }
  | { kind: "legacy"; raw: Uint8Array };

export function classifyName(raw: Uint8Array, flags: number, unicodePath: Uint8Array | null): RecordName {
  if (flags & UTF8_FLAG || isAscii(raw)) return { kind: "utf8", name: decodeUtf8(raw) ?? decodeCp437(raw) };
  const asUtf8 = decodeUtf8(raw);
  if (asUtf8 !== null) return { kind: "utf8", name: asUtf8 };
  const fromExtra = unicodePath && decodeUtf8(unicodePath);
  if (fromExtra) return { kind: "utf8", name: fromExtra };
  return { kind: "legacy", raw };
}

export function decodeShiftJis(raw: Uint8Array): string | null {
  try {
    return strictShiftJis.decode(raw);
  } catch {
    return null;
  }
}

export function decodeLegacy(raw: Uint8Array, encoding: LegacyEncoding): string {
  return (encoding === "shift_jis" && decodeShiftJis(raw)) || decodeCp437(raw);
}

function decodeUtf8(raw: Uint8Array): string | null {
  try {
    return strictUtf8.decode(raw);
  } catch {
    return null;
  }
}

function decodeCp437(raw: Uint8Array): string {
  let out = "";
  for (const b of raw) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

function isAscii(raw: Uint8Array): boolean {
  for (const b of raw) if (b >= 0x80) return false;
  return true;
}

export function normalize(name: string): string {
  return clean(name.replaceAll("\\", "/").replace(/^\//, ""));
}

function clean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") out.push(segment);
    else if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (!rooted) out.push("..");
  }
  const joined = out.join("/");
  if (rooted) return `/${joined}`;
  return joined || ".";
}

export class RootDetector {
  private root: string | null = null;
  private conflict = false;

  observe(normalized: string): void {
    if (this.conflict) return;
    const slash = normalized.indexOf("/");
    const segment = slash < 0 ? normalized : normalized.slice(0, slash);
    if (this.root === null) this.root = segment;
    else if (segment !== this.root) this.conflict = true;
  }

  result(archiveFilename: string): string {
    if (this.conflict || !this.root) return "";
    const ext = ROOT_EXTENSIONS.find((e) => archiveFilename.toLowerCase().endsWith(e));
    const base = ext ? archiveFilename.slice(0, -ext.length) : archiveFilename;
    return this.root === base || this.root === archiveFilename ? `${this.root}/` : "";
  }
}

export function entryPath(normalized: string, rootPrefix: string): string | null {
  const path = rootPrefix && normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : normalized;
  if (path === "." || path === ".." || path.startsWith("../") || path.startsWith("/")) return null;
  return path;
}
