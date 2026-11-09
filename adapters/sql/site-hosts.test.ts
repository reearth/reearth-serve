// `SqlSiteHostStore` against a real SQLite engine, so the SQL the Worker sends
// to D1 is the SQL a test executes (ADR-012 §3, ADR-013 B2).
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { SqlSiteHostStore } from "./site-hosts";
import type { SiteHost } from "../../core/site/repository";

const SUFFIX = ".serve.example.test";

const ASSET_IDS = ["3f9a1c2b4d5e6f70", "fedcba9876543210"];

/** A store over a database holding the assets the rows below point at. */
function store(): SqlSiteHostStore {
  return storeWith(ASSET_IDS);
}

function storeWith(assetIds: string[]): SqlSiteHostStore {
  const sql = createSqliteClient();
  // node:sqlite is synchronous underneath: the row is written before
  // `execute` returns its promise, so the store can be handed back as is.
  for (const id of assetIds) {
    void sql.execute(
      "INSERT INTO assets (id, filename, content_type, size, created_at, expires_at) VALUES (?1, 'site.zip', 'application/zip', 1, 0, 0)",
      [id],
    );
  }
  return new SqlSiteHostStore(sql);
}

function host(over: Partial<SiteHost> = {}): SiteHost {
  return {
    hostname: `flood-map${SUFFIX}`,
    assetId: "3f9a1c2b4d5e6f70",
    projectId: "p1",
    kind: "subdomain",
    verifiedAt: null,
    disabledAt: null,
    previews: false,
    releasedAt: null,
    createdAt: 1000,
    createdBy: "u1",
    verificationToken: null,
    certificateStatus: null,
    ...over,
  };
}

describe("SqlSiteHostStore", () => {
  test("insert and find round-trip every column", async () => {
    const s = store();
    expect(await s.insert(host())).toBe(true);
    expect(await s.find(`flood-map${SUFFIX}`)).toEqual(host());
    expect(await s.find(`nothing${SUFFIX}`)).toBeNull();
  });

  test("previews survives the 0/1 column round-trip", async () => {
    const s = store();
    await s.insert(host({ previews: true }));
    expect((await s.find(`flood-map${SUFFIX}`))?.previews).toBe(true);
  });

  test("update writes only the fields it was given (ADR-013 B3/B4)", async () => {
    const s = store();
    const hostname = `flood-map${SUFFIX}`;
    await s.insert(host());

    await s.update(hostname, { disabledAt: 4000 });
    expect(await s.find(hostname)).toEqual(host({ disabledAt: 4000 }));

    // previews alone leaves disabled_at where it was, and the other way round.
    await s.update(hostname, { previews: true });
    expect(await s.find(hostname)).toEqual(host({ disabledAt: 4000, previews: true }));

    await s.update(hostname, { disabledAt: null });
    expect(await s.find(hostname)).toEqual(host({ disabledAt: null, previews: true }));

    // An empty patch issues no statement at all.
    await s.update(hostname, {});
    expect(await s.find(hostname)).toEqual(host({ previews: true }));
  });

  test("the B5 verification columns round-trip and patch independently", async () => {
    const s = store();
    const custom = {
      hostname: "map.city.example.jp",
      kind: "custom" as const,
      verificationToken: "0123456789abcdef0123456789abcdef",
    };
    await s.insert(host(custom));
    expect(await s.find("map.city.example.jp")).toEqual(host(custom));

    // Verification writes both columns at once…
    await s.update("map.city.example.jp", { verifiedAt: 7000, certificateStatus: "pending" });
    expect(await s.find("map.city.example.jp")).toEqual(
      host({ ...custom, verifiedAt: 7000, certificateStatus: "pending" }),
    );

    // …and the single-row GET refreshes only the certificate afterwards.
    await s.update("map.city.example.jp", { certificateStatus: "active" });
    expect(await s.find("map.city.example.jp")).toEqual(
      host({ ...custom, verifiedAt: 7000, certificateStatus: "active" }),
    );

    // A subdomain keeps both columns null through a B3/B4 patch.
    await s.insert(host());
    await s.update(`flood-map${SUFFIX}`, { previews: true });
    const row = await s.find(`flood-map${SUFFIX}`);
    expect(row?.verificationToken).toBeNull();
    expect(row?.certificateStatus).toBeNull();
  });

  test("update never revives a released row", async () => {
    const s = store();
    const hostname = `flood-map${SUFFIX}`;
    await s.insert(host({ disabledAt: 4000 }));
    await s.release(hostname, 9000);

    await s.update(hostname, { disabledAt: null, previews: true });
    const row = await s.find(hostname);
    expect(row?.releasedAt).toBe(9000);
    expect(row?.disabledAt).toBe(4000);
    expect(row?.previews).toBe(false);
  });

  test("the primary key rejects a second claim on the same hostname", async () => {
    const s = store();
    expect(await s.insert(host())).toBe(true);
    expect(await s.insert(host({ assetId: "fedcba9876543210", projectId: "p2" }))).toBe(false);
    // The first row is untouched — a lost race must not overwrite.
    expect((await s.find(`flood-map${SUFFIX}`))?.projectId).toBe("p1");
  });

  test("a released row still holds the name against a new claim", async () => {
    const s = store();
    await s.insert(host());
    await s.release(`flood-map${SUFFIX}`, 9000);
    expect(await s.insert(host({ createdAt: 9500 }))).toBe(false);
  });

  test("listByAsset and listByProject skip released rows, oldest first", async () => {
    const s = store();
    await s.insert(host({ hostname: `a${SUFFIX}`, createdAt: 2000 }));
    await s.insert(host({ hostname: `b${SUFFIX}`, createdAt: 1000 }));
    await s.insert(host({ hostname: `c${SUFFIX}`, createdAt: 3000 }));
    await s.insert(host({ hostname: `d${SUFFIX}`, assetId: "fedcba9876543210", projectId: "p2" }));

    expect((await s.listByAsset("3f9a1c2b4d5e6f70")).map((h) => h.hostname)).toEqual([
      `b${SUFFIX}`, `a${SUFFIX}`, `c${SUFFIX}`,
    ]);
    expect((await s.listByProject("p1")).length).toBe(3);
    expect((await s.listByProject("p2")).map((h) => h.hostname)).toEqual([`d${SUFFIX}`]);

    await s.release(`a${SUFFIX}`, 5000);
    expect((await s.listByAsset("3f9a1c2b4d5e6f70")).map((h) => h.hostname)).toEqual([
      `b${SUFFIX}`, `c${SUFFIX}`,
    ]);
    expect(await s.countActiveByProject("p1")).toBe(2);
  });

  test("release sets released_at and nulls asset_id", async () => {
    const s = store();
    await s.insert(host());
    await s.release(`flood-map${SUFFIX}`, 9000);
    const row = await s.find(`flood-map${SUFFIX}`);
    expect(row).toMatchObject({ releasedAt: 9000, assetId: null, projectId: "p1" });
  });

  test("release does not restart the cooldown of an already-released row", async () => {
    const s = store();
    await s.insert(host());
    await s.release(`flood-map${SUFFIX}`, 9000);
    await s.release(`flood-map${SUFFIX}`, 20000);
    expect((await s.find(`flood-map${SUFFIX}`))?.releasedAt).toBe(9000);
  });

  // compliance#258 REL-11 follow-up: a claim racing the asset's delete.
  test("insert refuses a row whose asset no longer exists", async () => {
    const s = storeWith([]);
    expect(await s.insert(host())).toBe(false);
    expect(await s.find(`flood-map${SUFFIX}`)).toBeNull();
  });

  test("released verified custom domains stay listed until their certificate is marked released", async () => {
    const s = store();
    const custom = (name: string, over: Partial<SiteHost> = {}) =>
      host({ hostname: name, kind: "custom", verifiedAt: 500, certificateStatus: "active", ...over });
    await s.insert(custom("b.example.com"));
    await s.insert(custom("a.example.com"));
    await s.insert(custom("unverified.example.com", { verifiedAt: null, certificateStatus: null }));
    await s.insert(custom("live.example.com"));
    await s.insert(host({ hostname: `sub${SUFFIX}` }));
    await s.release("b.example.com", 2000);
    await s.release("a.example.com", 1000);
    await s.release("unverified.example.com", 1000);
    await s.release(`sub${SUFFIX}`, 1000);

    expect((await s.listCertificatesToRelease(10)).map((h) => h.hostname)).toEqual(["a.example.com", "b.example.com"]);
    expect((await s.listCertificatesToRelease(1)).map((h) => h.hostname)).toEqual(["a.example.com"]);

    await s.markCertificateReleased("a.example.com");
    // An active row is never marked: the guard is released_at IS NOT NULL.
    await s.markCertificateReleased("live.example.com");
    expect((await s.listCertificatesToRelease(10)).map((h) => h.hostname)).toEqual(["b.example.com"]);
    expect((await s.find("live.example.com"))?.certificateStatus).toBe("active");
  });

  test("purgeReleasedBefore takes only rows past the cutoff, bounded by limit", async () => {
    const s = store();
    await s.insert(host({ hostname: `old${SUFFIX}` }));
    await s.insert(host({ hostname: `older${SUFFIX}` }));
    await s.insert(host({ hostname: `fresh${SUFFIX}` }));
    await s.insert(host({ hostname: `active${SUFFIX}` }));
    await s.release(`old${SUFFIX}`, 2000);
    await s.release(`older${SUFFIX}`, 1000);
    await s.release(`fresh${SUFFIX}`, 9000);

    expect(await s.purgeReleasedBefore(5000, 1)).toEqual([`older${SUFFIX}`]);
    expect(await s.purgeReleasedBefore(5000, 10)).toEqual([`old${SUFFIX}`]);
    expect(await s.purgeReleasedBefore(5000, 10)).toEqual([]);
    // The fresh release and the active row are still there.
    expect(await s.find(`fresh${SUFFIX}`)).not.toBeNull();
    expect(await s.find(`active${SUFFIX}`)).not.toBeNull();
  });

  test("remove drops a row outright", async () => {
    const s = store();
    await s.insert(host());
    await s.remove(`flood-map${SUFFIX}`);
    expect(await s.find(`flood-map${SUFFIX}`)).toBeNull();
    // …and the name is claimable again.
    expect(await s.insert(host())).toBe(true);
  });
});
