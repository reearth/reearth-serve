import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decodeShiftJis } from "./names";

const vectors = JSON.parse(readFileSync(new URL("../../scripts/fixtures/zip/data/shift-jis.json", import.meta.url), "utf8")) as { hex: string; name: string | null }[];

test.each(vectors)("Shift_JIS $hex decodes as the extractor decodes it", ({ hex, name }) => {
  expect(decodeShiftJis(Uint8Array.from(Buffer.from(hex, "hex")))).toBe(name);
});
