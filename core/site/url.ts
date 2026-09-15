/**
 * The site host URL of an asset (ADR-013 B1).
 *
 * Only archives get one: a site is an extracted archive, and pointing a
 * hostname at a single GeoJSON would promise a site that does not exist. The
 * scheme follows `baseUrl`, so a local `http://` deployment keeps working.
 */
export function siteUrlFor(opts: {
  assetId: string;
  baseUrl: string;
  siteHostSuffix: string | undefined;
  archive: boolean;
}): string | undefined {
  if (!opts.archive || !opts.siteHostSuffix) return undefined;
  let protocol = "https:";
  try {
    protocol = new URL(opts.baseUrl).protocol;
  } catch {
    // A malformed BASE_URL is a deployment problem, not a reason to fail an
    // upload; https is the only sane default for a public hostname.
  }
  return `${protocol}//${opts.assetId}${opts.siteHostSuffix}/`;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("siteUrlFor builds the host from the ID and the suffix", () => {
    expect(
      siteUrlFor({
        assetId: "3f9a1c2b4d5e6f70",
        baseUrl: "https://serve.reearth.land",
        siteHostSuffix: ".serve.reearth.land",
        archive: true,
      }),
    ).toBe("https://3f9a1c2b4d5e6f70.serve.reearth.land/");
  });

  test("siteUrlFor follows the scheme (and port suffix) of a local deployment", () => {
    expect(
      siteUrlFor({
        assetId: "3f9a1c2b4d5e6f70",
        baseUrl: "http://localhost:8787",
        siteHostSuffix: ".localhost:8787",
        archive: true,
      }),
    ).toBe("http://3f9a1c2b4d5e6f70.localhost:8787/");
  });

  test("siteUrlFor is undefined without a suffix or for a non-archive", () => {
    const base = { assetId: "3f9a1c2b4d5e6f70", baseUrl: "https://serve.reearth.land" };
    expect(siteUrlFor({ ...base, siteHostSuffix: undefined, archive: true })).toBeUndefined();
    expect(siteUrlFor({ ...base, siteHostSuffix: ".serve.reearth.land", archive: false })).toBeUndefined();
  });
}
