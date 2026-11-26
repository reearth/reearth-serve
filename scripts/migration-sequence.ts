import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type MigrationFile = { name: string; prefix: string; bytes: Uint8Array };

export type Violation =
  | { kind: "bad-name"; name: string }
  | { kind: "duplicate-prefix"; prefix: string; names: string[] }
  | { kind: "base-missing"; name: string }
  | { kind: "base-changed"; name: string }
  | { kind: "not-after-base"; name: string; highest: string }
  | { kind: "bare-nolint"; name: string }
  | { kind: "shared-name"; name: string };

const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const NOLINT = /atlas:nolint\b(.*)$/gm;
const ANALYZER_CODES = /^[A-Z]{2}\d{3}(\s+[A-Z]{2}\d{3})*$/;
const IGNORED = new Set(["atlas.sum"]);

export function migrationFile(name: string, bytes: Uint8Array): MigrationFile {
  return { name, prefix: name.split("_")[0], bytes };
}

function hasBareNolint(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return [...text.matchAll(NOLINT)].some((match) => !ANALYZER_CODES.test(match[1].trim()));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function checkMigrations({
  base,
  head,
  otherDirNames,
}: {
  base: MigrationFile[];
  head: MigrationFile[];
  otherDirNames: ReadonlySet<string>;
}): Violation[] {
  const violations: Violation[] = [];
  const headByName = new Map(head.map((file) => [file.name, file]));
  const baseNames = new Set(base.map((file) => file.name));

  for (const file of head) {
    if (!NAME.test(file.name)) violations.push({ kind: "bad-name", name: file.name });
    if (hasBareNolint(file.bytes)) violations.push({ kind: "bare-nolint", name: file.name });
    if (otherDirNames.has(file.name)) violations.push({ kind: "shared-name", name: file.name });
  }

  const byPrefix = new Map<string, MigrationFile[]>();
  for (const file of head) byPrefix.set(file.prefix, [...(byPrefix.get(file.prefix) ?? []), file]);
  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) violations.push({ kind: "duplicate-prefix", prefix, names: files.map((f) => f.name) });
  }

  for (const file of base) {
    const current = headByName.get(file.name);
    if (!current) violations.push({ kind: "base-missing", name: file.name });
    else if (!sameBytes(current.bytes, file.bytes)) violations.push({ kind: "base-changed", name: file.name });
  }

  const highest = base.map((file) => file.prefix).sort().at(-1);
  if (highest !== undefined) {
    for (const file of head) {
      if (!baseNames.has(file.name) && file.prefix <= highest) {
        violations.push({ kind: "not-after-base", name: file.name, highest });
      }
    }
  }

  return violations;
}

const DESCRIBE: { [K in Violation["kind"]]: (v: Extract<Violation, { kind: K }>) => string } = {
  "bad-name": (v) => `${v.name}: name must match NNNN_lower_snake.sql`,
  "duplicate-prefix": (v) => `prefix ${v.prefix} is used by ${v.names.join(", ")}; renumber the newer file`,
  "base-missing": (v) => `${v.name}: exists on the base branch but was deleted or renamed`,
  "base-changed": (v) => `${v.name}: differs from the base branch; add a new migration instead of editing a merged one`,
  "not-after-base": (v) => `${v.name}: new files must sort after the base branch's highest prefix ${v.highest}; renumber it`,
  "bare-nolint": (v) =>
    `${v.name}: atlas:nolint must name the analyzer codes it waives, as in "-- atlas:nolint DS102"`,
  "shared-name": (v) => `${v.name}: the same file name exists in another migration directory`,
};

export function describeViolation(v: Violation): string {
  return (DESCRIBE[v.kind] as (v: Violation) => string)(v);
}

function isMigrationEntry(name: string): boolean {
  return !IGNORED.has(name) && !name.startsWith(".");
}

function readHead(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter(isMigrationEntry)
    .map((name) => migrationFile(name, readFileSync(join(dir, name))));
}

function git(args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
}

function readBase(ref: string, dir: string): MigrationFile[] {
  const listing = git(["ls-tree", "-z", "--name-only", ref, "--", `${dir}/`]).toString("utf8");
  return listing
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, name: path.slice(dir.length + 1) }))
    .filter(({ name }) => isMigrationEntry(name))
    .map(({ path, name }) => migrationFile(name, git(["show", `${ref}:${path}`])));
}

function parseArgs(argv: string[]): { base: string; dirs: string[] } {
  const [flag, base, ...dirs] = argv;
  if (flag !== "--base" || !base || dirs.length === 0) {
    throw new Error("usage: tsx scripts/migration-sequence.ts --base <git-ref> <dir>...");
  }
  return { base, dirs: dirs.map((dir) => dir.replace(/\/+$/, "")) };
}

function main(argv: string[]): number {
  const { base, dirs } = parseArgs(argv);
  const heads = new Map(dirs.map((dir) => [dir, readHead(dir)]));
  let failed = false;
  for (const dir of dirs) {
    const otherDirNames = new Set(
      dirs.filter((other) => other !== dir).flatMap((other) => heads.get(other)!.map((f) => f.name)),
    );
    const violations = checkMigrations({ base: readBase(base, dir), head: heads.get(dir)!, otherDirNames });
    for (const v of violations) console.error(`${dir}: ${describeViolation(v)}`);
    failed ||= violations.length > 0;
  }
  if (!failed) console.log(`migration sequence ok against ${base}: ${dirs.join(", ")}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
