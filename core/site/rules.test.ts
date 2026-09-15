/**
 * `_headers` / `_redirects` parsing and matching (ADR-013 C3).
 *
 * The parser is the whole security boundary of the feature — the denylist, the
 * internal-target rule and the caps are enforced here and nowhere else, because
 * the file handler applies what is stored without re-checking it. So every
 * rejection gets a test, not just the happy path.
 */
import { describe, expect, test } from "vitest";
import {
  boundHosting,
  MAX_CONTROL_FILE_BYTES,
  MAX_HEADER_RULES,
  MAX_HEADER_VALUE_BYTES,
  MAX_HEADERS_PER_RULE,
  MAX_HOSTING_JSON_BYTES,
  MAX_REDIRECT_RULES,
  matchHeaders,
  matchPattern,
  matchRedirect,
  parseHeaders,
  parseRedirects,
} from "./rules";

describe("parseHeaders", () => {
  test("blocks, comments, blank lines and indentation", () => {
    const { rules, warnings } = parseHeaders([
      "# a comment",
      "",
      "/*",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: no-referrer",
      "",
      "# another comment",
      "/admin/*",
      "\tContent-Security-Policy: default-src 'self'",
    ].join("\n"));

    expect(warnings).toEqual([]);
    expect(rules).toEqual([
      { pattern: "/*", headers: { "x-frame-options": "DENY", "referrer-policy": "no-referrer" } },
      { pattern: "/admin/*", headers: { "content-security-policy": "default-src 'self'" } },
    ]);
  });

  test("names are lowercased and values keep their spacing", () => {
    const { rules } = parseHeaders("/*\n  Permissions-Policy:  geolocation=(self \"https://x.test\")");
    expect(rules[0].headers["permissions-policy"]).toBe('geolocation=(self "https://x.test")');
  });

  test("the last mention of a header wins, inside a block and across blocks", () => {
    const { rules } = parseHeaders([
      "/*",
      "  X-Frame-Options: SAMEORIGIN",
      "  X-Frame-Options: DENY",
      "/a",
      "  X-Frame-Options: SAMEORIGIN",
    ].join("\n"));
    expect(rules[0].headers["x-frame-options"]).toBe("DENY");
    expect(matchHeaders(rules, "/a")).toEqual({ "x-frame-options": "SAMEORIGIN" });
    expect(matchHeaders(rules, "/b")).toEqual({ "x-frame-options": "DENY" });
  });

  test("a denylisted header is dropped with a warning, the rest of the block survives", () => {
    const { rules, warnings } = parseHeaders([
      "/*",
      "  Cache-Control: public, max-age=99999999",
      "  ETag: \"mine\"",
      "  Vary: Origin",
      "  Content-Type: text/plain",
      "  Set-Cookie: a=b",
      "  Access-Control-Allow-Origin: https://evil.test",
      "  X-Content-Type-Options: nosniff",
    ].join("\n"));

    expect(rules).toEqual([{ pattern: "/*", headers: { "x-content-type-options": "nosniff" } }]);
    expect(warnings).toHaveLength(6);
    for (const name of [
      "cache-control", "etag", "vary", "content-type", "set-cookie",
      "access-control-allow-origin",
    ]) {
      expect(warnings.some((w) => w.includes(`"${name}" cannot be set by a rule`))).toBe(true);
    }
  });

  test("x-robots-tag is allowed — the handler still overrides it on a preview", () => {
    const { rules, warnings } = parseHeaders("/*\n  X-Robots-Tag: all");
    expect(warnings).toEqual([]);
    expect(rules[0].headers["x-robots-tag"]).toBe("all");
  });

  test("malformed lines warn without losing the file", () => {
    const { rules, warnings } = parseHeaders([
      "  X-Early: 1",
      "not-a-path",
      "  X-Orphan: 1",
      "/*",
      "  no colon here",
      "  Bad Name: 1",
      "  X-Good: 1",
    ].join("\n"));
    expect(rules).toEqual([{ pattern: "/*", headers: { "x-good": "1" } }]);
    expect(warnings).toHaveLength(5);
  });

  test("a control character in a value is refused", () => {
    const { rules, warnings } = parseHeaders("/*\n  X-Bad: ab");
    expect(rules).toEqual([]);
    expect(warnings[0]).toContain("control character");
  });

  test("a mid-pattern star is refused", () => {
    const { rules, warnings } = parseHeaders("/a/*/b\n  X: 1");
    expect(rules).toEqual([]);
    expect(warnings[0]).toContain("last segment");
  });

  test("a block with nothing usable left in it is dropped", () => {
    expect(parseHeaders("/*\n  Cache-Control: none").rules).toEqual([]);
  });

  describe("caps ignore the whole file", () => {
    test("file size", () => {
      const text = `/*\n  X-Pad: ${"a".repeat(MAX_CONTROL_FILE_BYTES)}`;
      const { rules, warnings } = parseHeaders(text);
      expect(rules).toEqual([]);
      expect(warnings).toEqual([`_headers ignored: the file is larger than ${MAX_CONTROL_FILE_BYTES} bytes`]);
    });

    test("rule count", () => {
      const text = Array.from(
        { length: MAX_HEADER_RULES + 1 },
        (_, i) => `/p${i}\n  X-A: 1`,
      ).join("\n");
      const { rules, warnings } = parseHeaders(text);
      expect(rules).toEqual([]);
      expect(warnings[0]).toContain(`more than ${MAX_HEADER_RULES} rules`);
    });

    test("headers per rule", () => {
      const headers = Array.from({ length: MAX_HEADERS_PER_RULE + 1 }, (_, i) => `  X-H${i}: 1`);
      const { rules, warnings } = parseHeaders(["/*", ...headers].join("\n"));
      expect(rules).toEqual([]);
      expect(warnings[0]).toContain(`more than ${MAX_HEADERS_PER_RULE} headers`);
    });

    test("value size", () => {
      const { rules, warnings } = parseHeaders(`/*\n  X-Big: ${"a".repeat(MAX_HEADER_VALUE_BYTES + 1)}`);
      expect(rules).toEqual([]);
      expect(warnings[0]).toContain(`larger than ${MAX_HEADER_VALUE_BYTES} bytes`);
    });

    test("exactly at the cap is accepted", () => {
      const headers = Array.from({ length: MAX_HEADERS_PER_RULE }, (_, i) => `  X-H${i}: 1`);
      expect(parseHeaders(["/*", ...headers].join("\n")).rules).toHaveLength(1);
    });
  });
});

describe("matchPattern", () => {
  test("exact, prefix and placeholder forms", () => {
    expect(matchPattern("/about", "/about")).toEqual({ params: {}, splat: "" });
    expect(matchPattern("/about", "/about/")).toBeNull();
    expect(matchPattern("/*", "/")).toEqual({ params: {}, splat: "" });
    expect(matchPattern("/*", "/a/b/c")).toEqual({ params: {}, splat: "a/b/c" });
    expect(matchPattern("/blog/*", "/blog/2026/post")).toEqual({ params: {}, splat: "2026/post" });
    expect(matchPattern("/blog/*", "/other")).toBeNull();
    expect(matchPattern("/users/:id", "/users/42")).toEqual({ params: { id: "42" }, splat: "" });
    expect(matchPattern("/users/:id", "/users/42/edit")).toBeNull();
    // A placeholder stands for a real segment.
    expect(matchPattern("/users/:id", "/users/")).toBeNull();
  });
});

describe("parseRedirects", () => {
  test("targets, statuses, comments and blank lines", () => {
    const { rules, warnings } = parseRedirects([
      "# comment",
      "",
      "/old        /new",
      "/temp       /somewhere        302",
      "/blog/*     /news/:splat      301!",
      "/users/:id  /profiles/:id     307",
      "/*          /index.html       200   # SPA",
    ].join("\n"));

    expect(warnings).toEqual([]);
    expect(rules).toEqual([
      { from: "/old", to: "/new", status: 301, force: false },
      { from: "/temp", to: "/somewhere", status: 302, force: false },
      { from: "/blog/*", to: "/news/:splat", status: 301, force: true },
      { from: "/users/:id", to: "/profiles/:id", status: 307, force: false },
      { from: "/*", to: "/index.html", status: 200, force: false },
    ]);
  });

  test("a bang on the target forces an implied 301", () => {
    expect(parseRedirects("/a /b!").rules).toEqual([
      { from: "/a", to: "/b", status: 301, force: true },
    ]);
  });

  test("external targets are refused", () => {
    const { rules, warnings } = parseRedirects([
      "/a https://evil.test/x 302",
      "/b //evil.test/x 302",
      "/c evil.test/x 302",
      "/d /ok 302",
      "/e /x\\y 302",
    ].join("\n"));
    expect(rules).toEqual([{ from: "/d", to: "/ok", status: 302, force: false }]);
    expect(warnings).toHaveLength(4);
    expect(warnings[1]).toContain("another origin");
  });

  test("bad statuses, bad sources and malformed lines are refused", () => {
    const { rules, warnings } = parseRedirects([
      "/a /b 418",
      "/a /b 3xx",
      "/a /b 200 extra",
      "a /b 301",
      "/a",
      "/a/*/b /c 301",
    ].join("\n"));
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(6);
  });

  test("the rule-count cap ignores the file", () => {
    const text = Array.from({ length: MAX_REDIRECT_RULES + 1 }, (_, i) => `/a${i} /b${i} 301`).join("\n");
    const { rules, warnings } = parseRedirects(text);
    expect(rules).toEqual([]);
    expect(warnings[0]).toContain(`more than ${MAX_REDIRECT_RULES} rules`);
  });

  test("the file-size cap ignores the file", () => {
    const line = `/${"a".repeat(200)} /b 301\n`;
    const text = line.repeat(Math.ceil(MAX_CONTROL_FILE_BYTES / line.length) + 1);
    expect(parseRedirects(text).warnings[0]).toContain("larger than");
  });
});

describe("matchRedirect", () => {
  const { rules } = parseRedirects([
    "/first     /a   301",
    "/first     /b   302",
    "/blog/*    /news/:splat   301",
    "/u/:id/x   /users/:id     308",
    "/dead/*    /               302",
  ].join("\n"));

  test("first match wins", () => {
    expect(matchRedirect(rules, "/first")).toEqual({ to: "/a", status: 301, force: false });
  });

  test(":splat and :placeholder are substituted", () => {
    expect(matchRedirect(rules, "/blog/2026/post")).toEqual({
      to: "/news/2026/post", status: 301, force: false,
    });
    expect(matchRedirect(rules, "/u/42/x")).toEqual({ to: "/users/42", status: 308, force: false });
    // An empty splat still leaves a rooted path.
    expect(matchRedirect(rules, "/dead/")).toEqual({ to: "/", status: 302, force: false });
  });

  test("no match is null", () => {
    expect(matchRedirect(rules, "/nothing")).toBeNull();
    expect(matchRedirect([], "/anything")).toBeNull();
  });
});

describe("boundHosting", () => {
  test("small rule sets pass through untouched", () => {
    const hosting = { headers: [], redirects: [], warnings: [] };
    expect(boundHosting(hosting)).toBe(hosting);
  });

  test("an oversized rule set is dropped and says so", () => {
    const headers = Array.from({ length: 200 }, (_, i) => ({
      pattern: `/p${i}`,
      headers: { "x-pad": "a".repeat(MAX_HEADER_VALUE_BYTES) },
    }));
    const bounded = boundHosting({ headers, redirects: [], warnings: ["earlier"] });
    expect(bounded.headers).toEqual([]);
    expect(bounded.warnings[0]).toBe("earlier");
    expect(bounded.warnings[1]).toContain(`exceed ${MAX_HOSTING_JSON_BYTES} bytes`);
  });
});
