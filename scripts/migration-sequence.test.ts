import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkMigrations, describeViolation, migrationFile, readHead, type MigrationFile } from "./migration-sequence";

const sql = (name: string, text = `CREATE TABLE ${name.split(".")[0].slice(5)} (id TEXT);\n`) =>
  migrationFile(name, new TextEncoder().encode(text));

const BASE = [sql("0001_init.sql"), sql("0002_assets.sql")];

function check(head: MigrationFile[], { base = BASE, otherDirNames = [] as string[] } = {}) {
  return checkMigrations({ base, head, otherDirNames: new Set(otherDirNames) });
}

describe("checkMigrations", () => {
  test("accepts the base files plus a new file after the highest prefix", () => {
    expect(check([...BASE, sql("0003_sites.sql")])).toEqual([]);
  });

  test("accepts any well-formed files when the base has none", () => {
    expect(check([sql("0001_init.sql")], { base: [] })).toEqual([]);
  });

  test("rejects a name outside NNNN_lower_snake.sql", () => {
    expect(check([...BASE, sql("0003_Sites.sql"), sql("0004_tags.txt")])).toEqual([
      { kind: "bad-name", name: "0003_Sites.sql" },
      { kind: "bad-name", name: "0004_tags.txt" },
    ]);
  });

  test("rejects two files with the same prefix", () => {
    expect(check([...BASE, sql("0003_sites.sql"), sql("0003_tags.sql")])).toEqual([
      { kind: "duplicate-prefix", prefix: "0003", names: ["0003_sites.sql", "0003_tags.sql"] },
    ]);
  });

  test("rejects a base file that was edited", () => {
    expect(check([BASE[0], sql("0002_assets.sql", "CREATE TABLE assets (id TEXT, x TEXT);\n")])).toEqual([
      { kind: "base-changed", name: "0002_assets.sql" },
    ]);
  });

  test("rejects a base file that was deleted or renamed", () => {
    expect(check([BASE[0], sql("0003_assets.sql")])).toEqual([{ kind: "base-missing", name: "0002_assets.sql" }]);
  });

  test("rejects a new file numbered at or below the base's highest prefix", () => {
    expect(check([...BASE, sql("0002_tags.sql")], { base: BASE })).toContainEqual({
      kind: "not-after-base",
      name: "0002_tags.sql",
      highest: "0002",
    });
  });

  test("rejects a bare atlas:nolint and allows one that names analyzer codes", () => {
    const bare = sql("0003_drop.sql", "-- atlas:nolint\nDROP TABLE assets;\n");
    expect(check([...BASE, bare])).toEqual([{ kind: "bare-nolint", name: "0003_drop.sql" }]);

    const coded = sql("0003_rebuild.sql", "-- atlas:nolint DS102 MF101\nDROP TABLE assets;\n");
    expect(check([...BASE, coded])).toEqual([]);
  });

  test("rejects a file name that also exists in another migration directory", () => {
    expect(check([...BASE, sql("0003_sites.sql")], { otherDirNames: ["0003_sites.sql"] })).toEqual([
      { kind: "shared-name", name: "0003_sites.sql" },
    ]);
  });

  test("every violation renders with its file or prefix", () => {
    const violations = check([sql("0001_init.sql", "-- atlas:nolint\n"), sql("0001_dup.sql")], {
      otherDirNames: ["0001_init.sql"],
    });
    expect(violations.map((v) => v.kind).sort()).toEqual(
      ["bare-nolint", "base-changed", "base-missing", "duplicate-prefix", "not-after-base", "shared-name"].sort(),
    );
    for (const v of violations) expect(describeViolation(v)).toMatch(/0001|0002/);
  });
});

describe("readHead", () => {
  test("reports dotfiles and subdirectories as bad names and skips only atlas.sum", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      writeFileSync(join(dir, "0001_init.sql"), "CREATE TABLE init (id TEXT);\n");
      writeFileSync(join(dir, "atlas.sum"), "h1:x\n");
      writeFileSync(join(dir, ".0009_drop.sql"), "DROP TABLE IF EXISTS assets;\n");
      mkdirSync(join(dir, "0010_nested.sql"));

      expect(checkMigrations({ base: [], head: readHead(dir), otherDirNames: new Set() })).toEqual(
        expect.arrayContaining([
          { kind: "bad-name", name: ".0009_drop.sql" },
          { kind: "bad-name", name: "0010_nested.sql/" },
        ]),
      );
      expect(readHead(dir).map((file) => file.name).sort()).toEqual(
        [".0009_drop.sql", "0001_init.sql", "0010_nested.sql/"].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
