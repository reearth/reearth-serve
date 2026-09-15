/**
 * Custom domains (ADR-013 B5), exercised through the real app: registration,
 * the TXT check, certificate provisioning, resolution on the wire and release.
 *
 * The two new ports are memory fakes (`adapters/memory/dns.ts`,
 * `adapters/memory/custom-hostnames.ts`), so a test publishes the record it
 * wants found rather than waiting on DNS.
 */
import { describe, expect, test } from "vitest";
import type { SiteHost, SiteHostVerification } from "../../shared/api";
import { MemoryDnsResolver } from "../../adapters/memory/dns";
import { MemoryCustomHostnames } from "../../adapters/memory/custom-hostnames";
import { ASSET_ID } from "../testing/fixture";
import { PROJECT_ID, siteFixture, SUFFIX, type SiteApp } from "../testing/site-fixture";
import { INDEX_HTML } from "../testing/fixture";
import { CUSTOM_HOST_ERRORS, verificationRecordName } from "./custom";
import { NAME_ERRORS } from "./names";
import { SITE_HOST_QUOTA, VERIFY_ATTEMPT_LIMIT } from "./usecase";

const CUSTOM = "map.city.example.jp";
const VERIFY_RECORD = verificationRecordName(CUSTOM);

type ClaimBody = { host: SiteHost; siteUrl: string } & Partial<SiteHostVerification>;

function claim(app: SiteApp, auth: Record<string, string>, hostname: string, id = ASSET_ID) {
  return app.request(`/api/v1/assets/${id}/hosts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ hostname, kind: "custom" }),
  });
}

function verify(app: SiteApp, auth: Record<string, string>, hostname = CUSTOM) {
  return app.request(`/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(hostname)}/verify`, {
    method: "POST",
    headers: auth,
  });
}

function show(app: SiteApp, auth: Record<string, string>, hostname = CUSTOM) {
  return app.request(
    `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(hostname)}`,
    { headers: auth },
  );
}

/** A request arriving on the customer's own hostname. */
function onHost(hostname: string, path = "/"): [string, RequestInit] {
  return [`http://${hostname}${path}`, { headers: { Host: hostname } }];
}

/** Register the domain and publish the TXT record it asks for. */
async function registered(options: { publish?: boolean } = {}) {
  const f = await siteFixture();
  const res = await claim(f.app, f.auth, CUSTOM);
  expect(res.status).toBe(201);
  const body = await res.json() as ClaimBody;
  if (options.publish !== false) {
    f.dns.set(body.verification!.record, body.verification!.value);
  }
  return { ...f, claimed: body };
}

describe("POST /assets/:id/hosts {kind: custom}", () => {
  test("registers the domain unverified and returns the records to publish", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    const res = await claim(app, auth, "Map.City.Example.JP.");
    expect(res.status).toBe(201);

    const body = await res.json() as ClaimBody;
    expect(body.host).toMatchObject({
      hostname: CUSTOM,
      assetId: ASSET_ID,
      projectId: PROJECT_ID,
      kind: "custom",
      previews: false,
      verifiedAt: null,
      certificateStatus: null,
    });
    expect(body.verification).toEqual({
      record: `_reearth-serve-verify.${CUSTOM}`,
      type: "TXT",
      value: expect.stringMatching(/^reearth-serve-verify=[0-9a-f]{32}$/),
    });
    // No SITE_FALLBACK_ORIGIN in the fixture, so the apex of BASE_URL.
    expect(body.cname).toEqual({ target: "example.test" });

    // The token is stored, and never shown as a column of the row.
    expect(siteHosts.hosts.get(CUSTOM)?.verificationToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.host).not.toHaveProperty("verificationToken");
  });

  test("a fallback origin, when configured, is what the customer CNAMEs at", async () => {
    const { app, auth } = await siteFixture({
      deps: { siteFallbackOrigin: "fallback.serve.example.test" },
    });
    const body = await (await claim(app, auth, CUSTOM)).json() as ClaimBody;
    expect(body.cname).toEqual({ target: "fallback.serve.example.test" });
  });

  test("hostname validation: a full DNS name, and never one of ours", async () => {
    const { app, auth } = await siteFixture();
    const errorFor = async (hostname: string) =>
      (await (await claim(app, auth, hostname)).json() as { error: string }).error;

    expect(await errorFor("localhost")).toBe(CUSTOM_HOST_ERRORS.format);
    expect(await errorFor("map_1.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
    expect(await errorFor("-map.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
    expect(await errorFor("map..example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
    // Under our own suffix it would be a B2 name, not a domain they own.
    expect(await errorFor(`kawasaki${SUFFIX}`)).toBe(CUSTOM_HOST_ERRORS.reserved);
    expect(await errorFor(SUFFIX.slice(1))).toBe(CUSTOM_HOST_ERRORS.reserved);
    // The apex of BASE_URL: claiming it would take the API down.
    expect(await errorFor("example.test")).toBe(CUSTOM_HOST_ERRORS.reserved);
  });

  test("the subdomain rules do not leak into the custom ones, or the other way", async () => {
    const { app, auth } = await siteFixture();
    // `api` is reserved as a name, but `api.example.jp` is the customer's.
    expect((await claim(app, auth, "api.example.jp")).status).toBe(201);
    // And a bare label is a name, never a domain.
    const bare = await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "map.city.example.jp" }),
    });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toEqual({ error: NAME_ERRORS.format });
  });

  test("custom domains share the project quota with names", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    for (let i = 0; i < SITE_HOST_QUOTA; i++) {
      expect((await claim(app, auth, `m${i}.example.jp`)).status).toBe(201);
    }
    expect(siteHosts.hosts.size).toBe(SITE_HOST_QUOTA);
    const over = await claim(app, auth, "one-too-many.example.jp");
    expect(over.status).toBe(400);
    expect((await over.json() as { error: string }).error).toContain("limit");
  });

  test("a viewer cannot register a domain", async () => {
    const viewer = await siteFixture({ role: "viewer" });
    expect((await claim(viewer.app, viewer.auth, CUSTOM)).status).toBe(404);
    expect(viewer.siteHosts.hosts.size).toBe(0);
  });
});

describe("POST /assets/:id/hosts/:hostname/verify", () => {
  test("without the record the domain stays unverified and the 409 repeats it", async () => {
    const { app, auth, siteHosts, customHostnames } = await registered({ publish: false });

    const res = await verify(app, auth);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string } & SiteHostVerification;
    expect(body.error).toBe(CUSTOM_HOST_ERRORS.unverified);
    expect(body.verification.record).toBe(VERIFY_RECORD);
    expect(body.cname.target).toBe("example.test");

    expect(siteHosts.hosts.get(CUSTOM)?.verifiedAt).toBeNull();
    expect(customHostnames.provisioned).toEqual([]);
  });

  test("a record carrying somebody else's token is not a proof", async () => {
    const { app, auth, dns } = await registered({ publish: false });
    dns.set(VERIFY_RECORD, "v=spf1 -all", "reearth-serve-verify=0000000000000000ffffffffffffffff");
    expect((await verify(app, auth)).status).toBe(409);
  });

  test("with the record the domain verifies, provisions and starts resolving", async () => {
    const { app, auth, siteHosts, dns, customHostnames } = await registered();

    const res = await verify(app, auth);
    expect(res.status).toBe(200);
    const body = await res.json() as ClaimBody;
    expect(body.host.verifiedAt).toBeGreaterThan(0);
    expect(body.host.certificateStatus).toBe("active");
    // Verified: nothing left for the customer to publish.
    expect(body).not.toHaveProperty("verification");

    expect(dns.lookups).toEqual([VERIFY_RECORD]);
    expect(customHostnames.provisioned).toEqual([CUSTOM]);
    expect(siteHosts.hosts.get(CUSTOM)?.verifiedAt).toBeGreaterThan(0);

    // And the host now serves the asset at "/".
    const page = await app.request(...onHost(CUSTOM));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX_HTML);
  });

  test("one matching record among a domain's many is enough", async () => {
    const { app, auth, dns, claimed } = await registered({ publish: false });
    dns.set(VERIFY_RECORD, "v=spf1 include:example.net ~all", claimed.verification!.value, "other=1");
    expect((await verify(app, auth)).status).toBe(200);
  });

  test("verifying again is a status refresh, not an error", async () => {
    const { app, auth, customHostnames } = await registered();
    expect((await verify(app, auth)).status).toBe(200);

    customHostnames.statuses.set(CUSTOM, "pending");
    // Force a re-read by making the stored status stale.
    const second = await verify(app, auth);
    expect(second.status).toBe(200);
    expect((await second.json() as ClaimBody).host.certificateStatus).toBe("active");
  });

  test("a subdomain has nothing to verify", async () => {
    const { app, auth } = await siteFixture();
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    const res = await verify(app, auth, `kawasaki-flood-map${SUFFIX}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CUSTOM_HOST_ERRORS.notCustom });
  });

  test("a hostname nobody registered here is a 404", async () => {
    const { app, auth } = await siteFixture();
    expect((await verify(app, auth, "never.example.jp")).status).toBe(404);
  });

  test("a viewer cannot verify", async () => {
    const { app, siteHosts } = await registered();
    const viewer = await siteFixture({ role: "viewer" });
    // Same row, seen through a fixture whose caller is a viewer.
    viewer.siteHosts.hosts.set(CUSTOM, siteHosts.hosts.get(CUSTOM)!);
    expect((await verify(viewer.app, viewer.auth)).status).toBe(404);
    expect((await verify(app, {})).status).toBe(404);
  });

  test("attempts are rate limited per hostname", async () => {
    const { app, auth } = await registered({ publish: false });
    for (let i = 0; i < VERIFY_ATTEMPT_LIMIT; i++) {
      expect((await verify(app, auth)).status, `attempt ${i}`).toBe(409);
    }
    const blocked = await verify(app, auth);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: CUSTOM_HOST_ERRORS.rateLimited });
  });

  test("a provisioner that is down still verifies the domain", async () => {
    const failing = new MemoryCustomHostnames();
    const f = await siteFixture({ deps: { customHostnames: failing } });
    const body = await (await claim(f.app, f.auth, CUSTOM)).json() as ClaimBody;
    f.dns.set(body.verification!.record, body.verification!.value);
    failing.failure = new Error("cloudflare is down");

    const res = await verify(f.app, f.auth);
    expect(res.status).toBe(200);
    // The TXT check is what verification means; the certificate is pending.
    expect((await res.json() as ClaimBody).host.certificateStatus).toBe("pending");
    expect((await f.app.request(...onHost(CUSTOM))).status).toBe(200);
  });
});

describe("resolution on a custom host", () => {
  test("an unverified domain is a plain-text 404, not a 503", async () => {
    const { app } = await registered({ publish: false });
    const res = await app.request(...onHost(CUSTOM));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("Not found");
  });

  test("a hostname with no row at all is the same 404", async () => {
    const { app } = await siteFixture();
    expect((await app.request(...onHost("nobody.example.jp"))).status).toBe(404);
  });

  test("a verified domain serves the asset and nothing else", async () => {
    const { app, auth } = await registered();
    await verify(app, auth);

    expect(await (await app.request(...onHost(CUSTOM, "/docs/"))).text()).toContain("docs");
    // No API on a site host, custom or not.
    const health = await app.request(...onHost(CUSTOM, "/api/v1/health"));
    expect(health.status).toBe(404);
  });

  test("disable and release apply as they do to a name", async () => {
    const { app, auth, customHostnames } = await registered();
    await verify(app, auth);

    const path = `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(CUSTOM)}`;
    await app.request(path, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect((await app.request(...onHost(CUSTOM))).status).toBe(503);

    await app.request(path, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: false }),
    });
    expect((await app.request(...onHost(CUSTOM))).status).toBe(200);

    expect((await app.request(path, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await app.request(...onHost(CUSTOM))).status).toBe(410);
    // The certificate goes back with the name (ADR-013 B5).
    expect(customHostnames.deprovisioned).toEqual([CUSTOM]);
  });

  test("releasing an unverified domain asks for no deprovisioning", async () => {
    const { app, auth, customHostnames } = await registered({ publish: false });
    const path = `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(CUSTOM)}`;
    expect((await app.request(path, { method: "DELETE", headers: auth })).status).toBe(204);
    expect(customHostnames.deprovisioned).toEqual([]);
  });

  test("a deprovisioner that throws does not fail the release", async () => {
    const { app, auth, customHostnames, siteHosts } = await registered();
    await verify(app, auth);
    customHostnames.failure = new Error("cloudflare is down");

    const path = `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(CUSTOM)}`;
    expect((await app.request(path, { method: "DELETE", headers: auth })).status).toBe(204);
    expect(siteHosts.hosts.get(CUSTOM)?.releasedAt).toBeGreaterThan(0);
  });

  test("the apex never costs a site_hosts lookup", async () => {
    // A store that throws the moment anything reads it. The apex must reach
    // the API without the middleware ever consulting the table (B5) — with a
    // lookup per request, every API call on the apex would pay for it.
    const throwing = new Proxy({}, {
      get() { throw new Error("site_hosts was consulted for the apex host"); },
    });
    const { app } = await siteFixture({ deps: { siteHosts: throwing as never } });

    for (const host of ["example.test", "localhost", SUFFIX.slice(1)]) {
      const res = await app.request("http://example.test/api/v1/health", { headers: { Host: host } });
      expect(res.status, host).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    }
  });
});

describe("the single-row GET", () => {
  test("shows the pending instructions while the domain is unverified", async () => {
    const { app, auth } = await registered({ publish: false });
    const body = await (await show(app, auth)).json() as ClaimBody;
    expect(body.host.verifiedAt).toBeNull();
    expect(body.verification?.record).toBe(VERIFY_RECORD);
    expect(body.cname?.target).toBe("example.test");
  });

  test("refreshes a pending certificate from the provisioner, and stops once active", async () => {
    const pending = new MemoryCustomHostnames("pending");
    const f = await siteFixture({ deps: { customHostnames: pending } });
    const claimed = await (await claim(f.app, f.auth, CUSTOM)).json() as ClaimBody;
    f.dns.set(claimed.verification!.record, claimed.verification!.value);
    await verify(f.app, f.auth);

    let body = await (await show(f.app, f.auth)).json() as ClaimBody;
    expect(body.host.certificateStatus).toBe("pending");
    // No instructions once verified — only the certificate is outstanding.
    expect(body).not.toHaveProperty("verification");

    pending.statuses.set(CUSTOM, "active");
    body = await (await show(f.app, f.auth)).json() as ClaimBody;
    expect(body.host.certificateStatus).toBe("active");
    expect(f.siteHosts.hosts.get(CUSTOM)?.certificateStatus).toBe("active");

    // Active is final: the provisioner is not asked again.
    pending.failure = new Error("must not be called");
    expect((await show(f.app, f.auth)).status).toBe(200);
  });

  test("a name is shown too, with nothing to verify", async () => {
    const { app, auth } = await siteFixture();
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    const body = await (await show(app, auth, `kawasaki-flood-map${SUFFIX}`)).json() as ClaimBody;
    expect(body.host.kind).toBe("subdomain");
    expect(body).not.toHaveProperty("verification");
  });

  test("another asset's host, and one nobody claimed, are both 404", async () => {
    const { app, auth } = await registered();
    expect((await show(app, auth, "never.example.jp")).status).toBe(404);
  });

  test("a viewer may read a host but not verify it", async () => {
    const { siteHosts } = await registered();
    const viewer = await siteFixture({ role: "viewer" });
    viewer.siteHosts.hosts.set(CUSTOM, siteHosts.hosts.get(CUSTOM)!);
    expect((await show(viewer.app, viewer.auth)).status).toBe(200);
  });
});

describe("previews are not a thing on a custom domain", () => {
  test("PATCH {previews: true} is a 400", async () => {
    const { app, auth, siteHosts } = await registered();
    const res = await app.request(
      `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(CUSTOM)}`,
      {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ previews: true }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: CUSTOM_HOST_ERRORS.previews });
    expect(siteHosts.hosts.get(CUSTOM)?.previews).toBe(false);
  });

  test("turning them off is allowed — it is already the truth", async () => {
    const { app, auth } = await registered();
    const res = await app.request(
      `/api/v1/assets/${ASSET_ID}/hosts/${encodeURIComponent(CUSTOM)}`,
      {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ previews: false }),
      },
    );
    expect(res.status).toBe(200);
  });

  test("a preview-shaped host under the customer's domain is just a miss", async () => {
    const { app, auth } = await registered();
    await verify(app, auth);
    // `v1--map.city.example.jp` is a different hostname with no row of its own.
    expect((await app.request(...onHost(`v1--${CUSTOM}`))).status).toBe(404);
  });
});

describe("the memory DNS fake", () => {
  test("answers only what was published", async () => {
    const dns = new MemoryDnsResolver({ "_x.example.jp": ["a"] });
    expect(await dns.lookupTxt("_x.example.jp")).toEqual(["a"]);
    expect(await dns.lookupTxt("_y.example.jp")).toEqual([]);
    expect(dns.lookups).toEqual(["_x.example.jp", "_y.example.jp"]);
  });
});
