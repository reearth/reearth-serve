import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type SourceFile = { path: string; source: string };
type Violation = { rule: Rule; path: string };

const RULES = [
  "1: core/ and shared/ import nothing from adapters/ or runtime/",
  "2: adapters/accounts/ is imported only through its index",
  "3: core/ and shared/ name neither accounts nor Re:Earth",
  "4: only core/auth/access.ts calls Authorizer.check",
  "5: only adapters/ reveal a bearer credential",
] as const;
type Rule = (typeof RULES)[number];
const [LAYERING, ACCOUNTS_INDEX, NEUTRAL_NAMES, ONE_DECISION_PATH, CREDENTIAL_REVEAL] = RULES;

const SOURCE_ROOTS = ["app", "adapters", "cli", "core", "e2e", "runtime", "shared"];
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const ALLOWED_NAMES = /reearth-serve|@reearth\//gi;
const FORBIDDEN_NAMES = [/\baccounts\b/i, /re:?earth/i];
const AUTHORIZER_CHECK = /authorizer\s*\??\.\s*check\s*\(/i;
const AUTHORIZER_ALIASES = [
  /\bauthorizer\s*:\s*([A-Za-z_$][\w$]*)/gi,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=[^;\n]*\bauthorizer\b/gi,
];
const REVEAL_CALL = /\.\s*reveal\s*\(/;
const CREDENTIAL_MODULE = "core/auth/types.ts";

function callsAuthorizerCheck(source: string): boolean {
  if (AUTHORIZER_CHECK.test(source)) return true;
  const aliases = AUTHORIZER_ALIASES.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
  return aliases.some((alias) => new RegExp(`(?<![\\w$])${alias.replace(/\$/g, "\\$")}\\s*\\??\\.\\s*check\\s*\\(`).test(source));
}

function importsOf(file: SourceFile): string[] {
  return [...file.source.matchAll(IMPORT_SPECIFIER)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("."))
    .map((spec) => posix.join(posix.dirname(file.path), spec));
}

function under(path: string, ...dirs: string[]): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

function rulesBrokenBy(file: SourceFile): Rule[] {
  const broken: Rule[] = [];
  const imports = importsOf(file);
  const neutral = under(file.path, "core", "shared");

  if (neutral && !file.path.endsWith(".test.ts") && imports.some((target) => under(target, "adapters", "runtime"))) {
    broken.push(LAYERING);
  }
  const accountsInternal = (target: string) =>
    under(target, "adapters/accounts") && !/^adapters\/accounts(\/index(\.ts)?)?$/.test(target);
  if (!under(file.path, "adapters/accounts") && imports.some(accountsInternal)) {
    broken.push(ACCOUNTS_INDEX);
  }
  const text = file.source.replace(ALLOWED_NAMES, "");
  if (neutral && FORBIDDEN_NAMES.some((name) => name.test(text))) {
    broken.push(NEUTRAL_NAMES);
  }
  if (file.path !== "core/auth/access.ts" && callsAuthorizerCheck(file.source)) {
    broken.push(ONE_DECISION_PATH);
  }
  if (!under(file.path, "adapters") && file.path !== CREDENTIAL_MODULE && REVEAL_CALL.test(file.source)) {
    broken.push(CREDENTIAL_REVEAL);
  }
  return broken;
}

function violations(files: SourceFile[]): Violation[] {
  return files.flatMap((file) => rulesBrokenBy(file).map((rule) => ({ rule, path: file.path })));
}

function readTree(): SourceFile[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(posix.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  return SOURCE_ROOTS.flatMap(walk).map((path) => ({ path, source: readFileSync(posix.join(root, path), "utf8") }));
}

describe("the source tree", () => {
  const tree = readTree();

  test("is read", () => {
    expect(tree.map((f) => f.path)).toContain("core/auth/access.ts");
  });

  test.each(RULES)("keeps rule %s", (rule) => {
    expect(violations(tree).filter((v) => v.rule === rule)).toEqual([]);
  });
});

describe("each rule reports a planted file", () => {
  const reported = (path: string, source: string) => violations([{ path, source }]);

  test("rule 1 reports core/ or shared/ reaching into adapters/ or runtime/", () => {
    expect(reported("core/types.ts", 'import "../adapters/sql/stores";')).toEqual([{ rule: LAYERING, path: "core/types.ts" }]);
    expect(reported("shared/api.ts", 'export { x } from "../runtime/node/config";')).toEqual([{ rule: LAYERING, path: "shared/api.ts" }]);
    expect(reported("core/a/b.ts", 'const m = await import("../../adapters/memory/storage");')).toEqual([{ rule: LAYERING, path: "core/a/b.ts" }]);
  });

  test("rule 1 accepts a *.test.ts file that tests a port against an adapter, and core importing core", () => {
    expect(reported("core/kv/port.test.ts", 'import { SqlKeyValue } from "../../adapters/sql/kv";')).toEqual([]);
    expect(reported("core/a/b.ts", 'import type { X } from "../../core/c";')).toEqual([]);
    expect(reported("adapters/sql/stores.ts", 'import type { X } from "../../core/c";')).toEqual([]);
  });

  test("rule 2 reports a file outside adapters/accounts/ importing past its index", () => {
    expect(reported("runtime/node/deps.ts", 'import { Client } from "../../adapters/accounts/client";'))
      .toEqual([{ rule: ACCOUNTS_INDEX, path: "runtime/node/deps.ts" }]);
    expect(reported("adapters/tenancy.ts", 'import { a } from "./accounts";')).toEqual([]);
    expect(reported("adapters/tenancy.ts", 'import { a } from "./accounts/index";')).toEqual([]);
    expect(reported("adapters/accounts/tenancy.ts", 'import { Client } from "./client";')).toEqual([]);
  });

  test("rule 3 reports the names in any core/ or shared/ file, test files included", () => {
    expect(reported("core/kv/port.test.ts", "// the accounts directory")).toEqual([{ rule: NEUTRAL_NAMES, path: "core/kv/port.test.ts" }]);
    expect(reported("shared/api.ts", "// used by Re:Earth CMS")).toEqual([{ rule: NEUTRAL_NAMES, path: "shared/api.ts" }]);
    expect(reported("core/x.ts", "const product = 'reearth';")).toEqual([{ rule: NEUTRAL_NAMES, path: "core/x.ts" }]);
  });

  test("rule 3 accepts the CLI name, the npm scope, a singular account, and adapters/", () => {
    expect(reported("core/x.ts", 'import "@reearth/compressible"; // reearth-serve upload')).toEqual([]);
    expect(reported("core/extraction/backoff.ts", "// the account vCPU budget")).toEqual([]);
    expect(reported("adapters/accounts/index.ts", "// Re:Earth accounts")).toEqual([]);
  });

  test("rule 4 reports an authorizer check outside core/auth/access.ts", () => {
    expect(reported("core/project/handler.ts", "await c.get(\"tenancy\").authorizer.check(req);"))
      .toEqual([{ rule: ONE_DECISION_PATH, path: "core/project/handler.ts" }]);
    expect(reported("core/auth/access.ts", "return await ctx.authorizer.check(req);")).toEqual([]);
    expect(reported("core/auth/permissions.ts", "async check(req: AuthzRequest) {}")).toEqual([]);
  });

  test.each([
    ["a destructured alias", 'const { authorizer: a } = c.get("tenancy");\nawait a.check(req);'],
    ["a destructured binding", 'const { authorizer } = c.get("tenancy");\nawait authorizer.check(req);'],
    ["an assigned alias", 'const decide = c.get("tenancy").authorizer;\nawait decide?.check(req);'],
    ["a typed alias", "const pdp: Authorizer = scope.authorizer;\nreturn pdp.check(req);"],
  ])("rule 4 reports %s of the authorizer", (_, source) => {
    expect(reported("core/project/handler.ts", source)).toEqual([{ rule: ONE_DECISION_PATH, path: "core/project/handler.ts" }]);
  });

  test("rule 4 accepts a check on something that is not the authorizer", () => {
    expect(reported("core/project/handler.ts", 'const { authorizer: a } = c.get("tenancy");\nawait other.check(a);')).toEqual([]);
  });

  test("rule 5 reports a credential revealed outside adapters/", () => {
    expect(reported("core/tenancy/middleware.ts", "fetch(url, { headers: { Authorization: caller.credential.reveal() } });"))
      .toEqual([{ rule: CREDENTIAL_REVEAL, path: "core/tenancy/middleware.ts" }]);
    expect(reported("runtime/node/deps.ts", "const t = caller.credential . reveal ();"))
      .toEqual([{ rule: CREDENTIAL_REVEAL, path: "runtime/node/deps.ts" }]);
    expect(reported("adapters/accounts/client.ts", "headers.set(\"Authorization\", `Bearer ${credential.reveal()}`);")).toEqual([]);
    expect(reported("core/auth/types.ts", "reveal(): string { return this.#token; }")).toEqual([]);
  });
});
