// `SqlSiteHostStore` against a real SQLite engine, so the SQL the Worker sends
// to D1 is the SQL a test executes (ADR-012 §3, ADR-013 B2).
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { SqlSiteHostStore } from "./site-hosts";
import type { SiteHost } from "../../core/site/repository";

const SUFFIX = ".serve.example.test";

function store(): SqlSiteHostStore {
  return new SqlSiteHostStore(createSqliteClient());
}

function host(over: Partial<SiteHost> = {}): SiteHost {
  return {
    hostname: `kawasaki-flood-map${SUFFIX}`,
    assetId: "3f9a1c2b4d5e6f70",
    projectId: "p1",
    kind: "subdomain",
    verifiedAt: null,
    disabledAt: null,
    previews: false,
    releasedAt: null,
    createdAt: 1000,
    createdBy: "u1",
    ...over,
  };
}

describe("SqlSiteHostStore", () => {
  test("insert and find round-trip every column", async () => {
    const s = store();
    expect(await s.insert(host())).toBe(true);
    expect(await s.find(`kawasaki-flood-map${SUFFIX}`)).toEqual(host());
    expect(await s.find(`nothing${SUFFIX}`)).toBeNull();
  });

  test("previews survives the 0/1 column round-trip", async () => {
    const s = store();
    await s.insert(host({ previews: true }));
    expect((await s.find(`kawasaki-flood-map${SUFFIX}`))?.previews).toBe(true);
  });

  test("update writes only the fields it was given (ADR-013 B3/B4)", async () => {
    const s = store();
    const hostname = `kawasaki-flood-map${SUFFIX}`;
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

  test("update never revives a released row", async () => {
    const s = store();
    const hostname = `kawasaki-flood-map${SUFFIX}`;
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
    expect((await s.find(`kawasaki-flood-map${SUFFIX}`))?.projectId).toBe("p1");
  });

  test("a released row still holds the name against a new claim", async () => {
    const s = store();
    await s.insert(host());
    await s.release(`kawasaki-flood-map${SUFFIX}`, 9000);
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
    await s.release(`kawasaki-flood-map${SUFFIX}`, 9000);
    const row = await s.find(`kawasaki-flood-map${SUFFIX}`);
    expect(row).toMatchObject({ releasedAt: 9000, assetId: null, projectId: "p1" });
  });

  test("release does not restart the cooldown of an already-released row", async () => {
    const s = store();
    await s.insert(host());
    await s.release(`kawasaki-flood-map${SUFFIX}`, 9000);
    await s.release(`kawasaki-flood-map${SUFFIX}`, 20000);
    expect((await s.find(`kawasaki-flood-map${SUFFIX}`))?.releasedAt).toBe(9000);
  });

  test("releaseByAsset releases every active name and reports them", async () => {
    const s = store();
    await s.insert(host({ hostname: `a${SUFFIX}` }));
    await s.insert(host({ hostname: `b${SUFFIX}` }));
    await s.insert(host({ hostname: `c${SUFFIX}`, assetId: "fedcba9876543210" }));
    await s.release(`b${SUFFIX}`, 100);

    expect((await s.releaseByAsset("3f9a1c2b4d5e6f70", 9000)).sort()).toEqual([`a${SUFFIX}`]);
    expect((await s.find(`a${SUFFIX}`))?.releasedAt).toBe(9000);
    // Another asset's name is untouched.
    expect((await s.find(`c${SUFFIX}`))?.releasedAt).toBeNull();
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
    await s.remove(`kawasaki-flood-map${SUFFIX}`);
    expect(await s.find(`kawasaki-flood-map${SUFFIX}`)).toBeNull();
    // …and the name is claimable again.
    expect(await s.insert(host())).toBe(true);
  });
});
