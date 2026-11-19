import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { contentTypeOf } from "./content-type";

const vectors = JSON.parse(
  readFileSync(new URL("../../scripts/fixtures/zip/data/content-types.json", import.meta.url), "utf8"),
) as { path: string; contentType: string }[];

test.each(vectors.map((v) => [v.path, v.contentType]))("an entry at %s is typed %s, as the extractor types its copy", (path, contentType) => {
  expect(contentTypeOf(path)).toBe(contentType);
});
