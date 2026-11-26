/**
 * The one reader of a Content-Type a client supplied (ADR-013 A4).
 *
 * A browser reads a Content-Type the Fetch way: it splits the value on commas
 * outside quoted strings and keeps the last type it can parse, so
 * `text/plain;x=,text/html` renders as HTML. Any looser reading here, such as
 * taking the text before the first `;`, lets a value mean one type to this
 * server and another to the browser. So a value is accepted only when it is
 * exactly one RFC 9110 `media-type` with no comma anywhere, and it is sent on
 * only in the normalized form this module builds, never as stored.
 *
 * The normalized form keeps `charset` alone among the parameters: text
 * rendering depends on it, nothing else this server serves reads the others,
 * and every byte kept is a byte some other parser might read differently.
 */

import { MAX_CONTENT_TYPE_LENGTH } from "../../shared/api";

/** A Content-Type in normalized form: lowercase `type/subtype`, then at most `; charset=<token>`. */
export type MediaType = string & { readonly __mediaType: unique symbol };

export const OCTET_STREAM = "application/octet-stream" as MediaType;

const VISIBLE = /^[\t\x20-\x7e]*$/;

/**
 * The normalized type, or `null` when `raw` is not exactly one media type.
 *
 * A single left-to-right scan, so the cost is linear in the input: a regex
 * over the optional-whitespace parameter grammar backtracks catastrophically
 * on long runs of `; `, and this runs on every upload and every file read.
 */
export function parseMediaType(raw: string | null | undefined): MediaType | null {
  if (raw == null || raw.length > MAX_CONTENT_TYPE_LENGTH || !VISIBLE.test(raw) || raw.includes(",")) return null;
  let i = 0;
  const skipWhitespace = () => { while (raw[i] === " " || raw[i] === "\t") i++; };
  const token = () => {
    const start = i;
    while (i < raw.length && isTokenChar(raw[i])) i++;
    return raw.slice(start, i);
  };
  /** The unescaped content of the quoted-string at `i`, or `null` when it is not closed. */
  const quoted = () => {
    let value = "";
    for (i++; i < raw.length; i++) {
      if (raw[i] === '"') { i++; return value; }
      if (raw[i] === "\\") i++;
      if (i < raw.length) value += raw[i];
    }
    return null;
  };

  skipWhitespace();
  const type = token();
  if (!type || raw[i++] !== "/") return null;
  const subtype = token();
  if (!subtype) return null;

  let charset: string | null = null;
  let charsetSeen = false;
  for (;;) {
    skipWhitespace();
    if (i === raw.length) break;
    if (raw[i++] !== ";") return null;
    skipWhitespace();
    if (i === raw.length || raw[i] === ";") continue;
    const name = token();
    if (!name || raw[i++] !== "=") return null;
    const value = raw[i] === '"' ? quoted() : token() || null;
    if (value === null) return null;
    if (!charsetSeen && name.toLowerCase() === "charset") {
      charsetSeen = true;
      charset = isToken(value) ? value.toLowerCase() : null;
    }
  }

  const essence = `${type}/${subtype}`.toLowerCase();
  if (essence === "*/*") return null;
  return (charset ? `${essence}; charset=${charset}` : essence) as MediaType;
}

const TOKEN_CHARS = new Set("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");

function isTokenChar(char: string): boolean {
  return TOKEN_CHARS.has(char);
}

function isToken(value: string): boolean {
  return value.length > 0 && [...value].every(isTokenChar);
}

/** The Content-Type to store for an upload: the normalized type, or octet-stream when there is none. */
export function storedMediaType(raw: string | null | undefined): MediaType {
  return parseMediaType(raw) ?? OCTET_STREAM;
}

/** `type/subtype` without parameters. */
export function essenceOf(type: MediaType): string {
  return type.split(";")[0];
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("parseMediaType accepts one media type and normalizes it", () => {
    const valid: Array<[string, string]> = [
      ["text/plain", "text/plain"],
      ["TEXT/HTML", "text/html"],
      [" \ttext/plain\t ", "text/plain"],
      ["text/html;charset=utf-8", "text/html; charset=utf-8"],
      ['text/plain ; Charset="UTF-8"', "text/plain; charset=utf-8"],
      ["text/plain; format=flowed; charset=iso-8859-1", "text/plain; charset=iso-8859-1"],
      ['application/json; a="b;c"', "application/json"],
      ["text/plain;", "text/plain"],
      ["image/svg+xml", "image/svg+xml"],
      ["application/vnd.mapbox-vector-tile", "application/vnd.mapbox-vector-tile"],
    ];
    for (const [raw, normalized] of valid) expect(parseMediaType(raw), raw).toBe(normalized);
  });

  test("parseMediaType rejects anything a browser could read as another type", () => {
    const invalid = [
      "text/plain;x=,text/html",
      'application/json;a=",text/html',
      'application/json;a=",text/html"',
      "text/plain, text/html",
      "image/png;,text/html",
      "text/plain,text/html",
      ",",
      ",text/html",
      "text/plain\r\nX-Injected: 1",
      "text/plain\ntext/html",
      "text/plain\0text/html",
      "text/plain\x7f",
      "text/plaín",
      "",
      "   ",
      "text",
      "text/",
      "/html",
      "text/html/x",
      "text /html",
      "text/plain; charset",
      "text/plain; =utf-8",
      'text/plain; charset="utf-8',
    ];
    for (const raw of invalid) expect(parseMediaType(raw), JSON.stringify(raw)).toBeNull();
  });

  test("parseMediaType rejects the essence */*, which Fetch reads as no type", () => {
    for (const raw of ["*/*", " */* ", "*/*; charset=utf-8"]) expect(parseMediaType(raw), raw).toBeNull();
    expect(parseMediaType("text/*")).toBe("text/*");
    expect(parseMediaType(undefined)).toBeNull();
    expect(parseMediaType(null)).toBeNull();
  });

  test("parseMediaType keeps the empty and quoted parameter forms RFC 9110 allows", () => {
    expect(parseMediaType("text/plain;")).toBe("text/plain");
    expect(parseMediaType("text/plain ; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(parseMediaType("text/plain;;charset=a")).toBe("text/plain; charset=a");
    expect(parseMediaType('text/plain; a="b;c"; charset=x')).toBe("text/plain; charset=x");
  });

  test("parseMediaType rejects a value longer than 256 bytes", () => {
    const at = (length: number) => "text/plain; a=" + "b".repeat(length - "text/plain; a=".length);
    expect(parseMediaType(at(256))).toBe("text/plain");
    expect(parseMediaType(at(257))).toBeNull();
  });

  test("parseMediaType runs in linear time on hostile input", () => {
    const hostile = ['a/b' + "; ".repeat(5000) + '"', ";  ".repeat(5000), " ; ".repeat(5000), "; a=b ".repeat(5000)];
    for (const raw of [...hostile, ...hostile.map((h) => "text/plain" + h), " ".repeat(10000) + "x", "a/b" + " ".repeat(10000) + "x"]) {
      const start = performance.now();
      parseMediaType(raw);
      expect(performance.now() - start, JSON.stringify(raw.slice(0, 20))).toBeLessThan(50);
    }
  });

  test("a charset that is not a token is dropped, not passed on", () => {
    expect(parseMediaType('text/plain; charset="utf 8"')).toBe("text/plain");
    expect(parseMediaType('text/plain; charset="a\\"b"')).toBe("text/plain");
  });

  test("the first charset wins", () => {
    expect(parseMediaType("text/plain; charset=utf-8; charset=shift_jis")).toBe("text/plain; charset=utf-8");
  });

  test("storedMediaType falls back to octet-stream", () => {
    expect(storedMediaType("text/plain;x=,text/html")).toBe(OCTET_STREAM);
    expect(storedMediaType(undefined)).toBe(OCTET_STREAM);
    expect(storedMediaType("Image/PNG")).toBe("image/png");
  });

  test("essenceOf drops the charset", () => {
    expect(essenceOf(parseMediaType("text/html; charset=utf-8")!)).toBe("text/html");
  });
}
