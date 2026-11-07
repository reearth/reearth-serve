import { describe, expect, test } from "vitest";
import { checkSiteIsolation } from "./isolation";

const valid = {
  SITE_HOST_SUFFIX: ".sites.example.net",
  BASE_URL: "https://api.example.com",
  SITE_REGISTRABLE_DOMAIN: "example.net",
};

describe("checkSiteIsolation (ADR-013 B1)", () => {
  test("no suffix, no requirement", () => {
    expect(checkSiteIsolation({})).toEqual({ publicSuffixOverride: false });
  });

  test("the API on one registrable domain and sites under another starts", () => {
    expect(checkSiteIsolation(valid)).toEqual({ publicSuffixOverride: false });
    // Case, port and a trailing dot are ignored.
    expect(checkSiteIsolation({
      SITE_HOST_SUFFIX: ".Sites.Example.NET.:8443",
      BASE_URL: "https://API.example.com.:8443",
      SITE_REGISTRABLE_DOMAIN: "EXAMPLE.net.",
    })).toEqual({ publicSuffixOverride: false });
  });

  test("a suffix needs BASE_URL and SITE_REGISTRABLE_DOMAIN", () => {
    expect(() => checkSiteIsolation({ ...valid, BASE_URL: undefined })).toThrow(/BASE_URL/);
    expect(() => checkSiteIsolation({ ...valid, SITE_REGISTRABLE_DOMAIN: "" })).toThrow(/SITE_REGISTRABLE_DOMAIN/);
  });

  test("a suffix outside the registrable domain refuses to start", () => {
    expect(() => checkSiteIsolation({ ...valid, SITE_HOST_SUFFIX: ".sites.example.org" })).toThrow(/SITE_HOST_SUFFIX/);
    // The domain itself is not "under" it.
    expect(() => checkSiteIsolation({ ...valid, SITE_HOST_SUFFIX: ".example.net" })).toThrow(/SITE_HOST_SUFFIX/);
    expect(() => checkSiteIsolation({ ...valid, SITE_HOST_SUFFIX: ".notexample.net" })).toThrow(/SITE_HOST_SUFFIX/);
  });

  test("BASE_URL on or under the sites' registrable domain refuses to start", () => {
    for (const BASE_URL of ["https://example.net", "https://api.example.net", "https://API.Example.Net.:443/"]) {
      expect(() => checkSiteIsolation({ ...valid, BASE_URL })).toThrow(/same site/);
    }
  });

  test("SITE_DOMAIN_IS_PUBLIC_SUFFIX=true is the one override", () => {
    const local = {
      SITE_HOST_SUFFIX: ".localhost:8788",
      BASE_URL: "http://localhost:8788",
      SITE_REGISTRABLE_DOMAIN: "localhost",
    };
    expect(() => checkSiteIsolation(local)).toThrow();
    expect(checkSiteIsolation({ ...local, SITE_DOMAIN_IS_PUBLIC_SUFFIX: "true" }))
      .toEqual({ publicSuffixOverride: true });
    expect(() => checkSiteIsolation({ ...local, SITE_DOMAIN_IS_PUBLIC_SUFFIX: "1" })).toThrow();
  });
});
