/**
 * The request side of a `/files` read (ADR-014 §4 Carry, Paths): where a
 * delivery token travels, the asset path, and the query with the token
 * stripped. Everything that reads `serve_token` or the raw path lives here, so
 * the handler never holds the unstripped query by accident.
 */

import { parseAssetPath, type AssetPath } from "./token";

export const TOKEN_QUERY = "serve_token";
export const TOKEN_HEADER = "X-Serve-Token";

export type TokenCarry =
  | { kind: "none" }
  | { kind: "one"; token: string }
  | { kind: "conflict" };

export interface DeliveryRequest {
  /** Null when the path cannot name anything inside an asset. */
  path: AssetPath | null;
  carry: TokenCarry;
  /** The request with every `serve_token` removed from its URL. */
  request: Request;
  url: URL;
  /** The query as sent, for the redirects a token read keeps it on. */
  sentSearch: string;
}

/**
 * Read a request routed to `/files/<id>/…`. `pathname` must be the raw,
 * still-encoded path: Hono's path parameter is decoded once already, and
 * decoding it again would turn `a%252Fb` into `a/b`.
 */
export function readDeliveryRequest(request: Request): DeliveryRequest {
  const url = new URL(request.url);
  const sentSearch = url.search;
  const { search, tokens } = splitTokens(sentSearch);
  const header = request.headers.get(TOKEN_HEADER) ?? "";
  // Repeated headers arrive joined by ", "; a token never contains a comma.
  const values = new Set([...tokens, ...header.split(",").map((v) => v.trim())].filter((v) => v !== ""));
  const [first] = values;
  const carry: TokenCarry = values.size === 0
    ? { kind: "none" }
    : values.size === 1 ? { kind: "one", token: first } : { kind: "conflict" };
  let stripped = request;
  if (search !== sentSearch) {
    url.search = search;
    stripped = new Request(url, request);
  }
  return { path: parseAssetPath(rawAssetPath(url.pathname)), carry, request: stripped, url, sentSearch };
}

/** The raw path after `/files/<id>`, its leading slash included. */
function rawAssetPath(pathname: string): string {
  const afterId = pathname.indexOf("/", "/files/".length);
  return afterId === -1 ? "" : pathname.slice(afterId);
}

/**
 * Split `serve_token` out of a query without re-serializing the rest, so
 * every other parameter reaches redirects byte for byte.
 */
function splitTokens(search: string): { search: string; tokens: string[] } {
  if (search === "") return { search, tokens: [] };
  const kept: string[] = [];
  const tokens: string[] = [];
  for (const pair of search.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (formDecode(name) === TOKEN_QUERY) tokens.push(eq === -1 ? "" : formDecode(pair.slice(eq + 1)));
    else if (pair !== "") kept.push(pair);
  }
  return { search: kept.length > 0 ? `?${kept.join("&")}` : "", tokens };
}

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const read = (path: string, headers: Record<string, string> = {}) =>
    readDeliveryRequest(new Request(`https://example.test${path}`, { headers }));

  test("the query form and the header form both carry, and an empty value counts as absent", () => {
    expect(read("/files/a/x?serve_token=t1").carry).toEqual({ kind: "one", token: "t1" });
    expect(read("/files/a/x", { "X-Serve-Token": "t1" }).carry).toEqual({ kind: "one", token: "t1" });
    expect(read("/files/a/x?serve_token=&serve_token=t1", { "X-Serve-Token": "" }).carry)
      .toEqual({ kind: "one", token: "t1" });
    expect(read("/files/a/x?serve_token=t1", { "X-Serve-Token": "t1" }).carry).toEqual({ kind: "one", token: "t1" });
    expect(read("/files/a/x").carry).toEqual({ kind: "none" });
  });

  test("two distinct values are a conflict, in any combination", () => {
    expect(read("/files/a/x?serve_token=t1", { "X-Serve-Token": "t2" }).carry).toEqual({ kind: "conflict" });
    expect(read("/files/a/x?serve_token=t1&serve_token=t2").carry).toEqual({ kind: "conflict" });
    expect(read("/files/a/x", { "X-Serve-Token": "t1, t2" }).carry).toEqual({ kind: "conflict" });
  });

  test("serve_token leaves the request URL and the rest of the query stays byte for byte", () => {
    const r = read("/files/a/x?v=2&serve_token=t1&q=a%20b+c&flag");
    expect(r.url.search).toBe("?v=2&q=a%20b+c&flag");
    expect(r.request.url).toBe("https://example.test/files/a/x?v=2&q=a%20b+c&flag");
    expect(r.sentSearch).toBe("?v=2&serve_token=t1&q=a%20b+c&flag");
    expect(read("/files/a/x?serve_token=t1").url.search).toBe("");
    expect(read("/files/a/x?%73erve_token=t1").carry).toEqual({ kind: "one", token: "t1" });
  });

  test("a request without a token keeps its Request object", () => {
    const original = new Request("https://example.test/files/a/x?v=2");
    expect(readDeliveryRequest(original).request).toBe(original);
  });

  test("the path is the raw path after the ID, decoded once", () => {
    expect(read("/files/a").path).toBe("");
    expect(read("/files/a/").path).toBe("");
    expect(read("/files/a/tiles/0.b3dm").path).toBe("tiles/0.b3dm");
    expect(read("/files/a/100%25.png").path).toBe("100%.png");
    expect(read("/files/a/a%2Fb").path).toBe("a/b");
    expect(read("/files/a/a%252Fb").path).toBeNull();
    expect(read("/files/a//x").path).toBeNull();
  });
}
