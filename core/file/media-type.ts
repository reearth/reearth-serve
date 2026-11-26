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

/** A Content-Type in normalized form: lowercase `type/subtype`, then at most `; charset=<token>`. */
export type MediaType = string & { readonly __mediaType: unique symbol };

export const OCTET_STREAM = "application/octet-stream" as MediaType;

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const PARAMETER = `(${TOKEN})=(${TOKEN}|${QUOTED})`;
const MEDIA_TYPE = new RegExp(`^(${TOKEN})/(${TOKEN})((?:[ \\t]*;[ \\t]*(?:${TOKEN}=(?:${TOKEN}|${QUOTED}))?)*)$`);
const TOKEN_ONLY = new RegExp(`^${TOKEN}$`);
const VISIBLE = /^[\t\x20-\x7e]*$/;

/** The normalized type, or `null` when `raw` is not exactly one media type. */
export function parseMediaType(raw: string | null | undefined): MediaType | null {
  if (raw == null || !VISIBLE.test(raw) || raw.includes(",")) return null;
  const match = MEDIA_TYPE.exec(raw.replace(/^[ \t]+|[ \t]+$/g, ""));
  if (!match) return null;
  const [, type, subtype, parameters] = match;
  const essence = `${type}/${subtype}`.toLowerCase();
  const charset = charsetOf(parameters);
  return (charset ? `${essence}; charset=${charset}` : essence) as MediaType;
}

/** The Content-Type to store for an upload: the normalized type, or octet-stream when there is none. */
export function storedMediaType(raw: string | null | undefined): MediaType {
  return parseMediaType(raw) ?? OCTET_STREAM;
}

/** `type/subtype` without parameters. */
export function essenceOf(type: MediaType): string {
  return type.split(";")[0];
}

function charsetOf(parameters: string): string | undefined {
  for (const [, name, value] of parameters.matchAll(new RegExp(PARAMETER, "g"))) {
    if (name.toLowerCase() !== "charset") continue;
    const unquoted = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value;
    return TOKEN_ONLY.test(unquoted) ? unquoted.toLowerCase() : undefined;
  }
  return undefined;
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
    expect(parseMediaType(undefined)).toBeNull();
    expect(parseMediaType(null)).toBeNull();
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
