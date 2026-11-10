import { expect, test } from "vitest";
import { parseDuration } from "./helpers";

test("parseDuration reads seconds and the s, m, h and d units", () => {
  expect(parseDuration("90", "--expires")).toBe(90);
  expect(parseDuration("90s", "--expires")).toBe(90);
  expect(parseDuration("30m", "--expires")).toBe(1800);
  expect(parseDuration("24h", "--expires")).toBe(86_400);
  expect(parseDuration("7d", "--expires")).toBe(604_800);
  for (const bad of ["", "1.5h", "h", "-1", "2w"]) expect(() => parseDuration(bad, "--expires")).toThrow(/--expires/);
});
