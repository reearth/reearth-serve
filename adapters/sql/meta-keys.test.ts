import { describe, expect, test } from "vitest";
import { assetMetadataSchema, assetVersionSchema } from "../../shared/api";
import type { SqlValue } from "../../core/sql/port";
import { assetUpsertArgs, versionExtractionUpdateArgs, versionInsertArgs } from "./stores";

const sentinel = (key: string) => `sentinel:${key}`;

function sentinelModel(keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, sentinel(k)]));
}

function droppedKeys(keys: string[], args: SqlValue[]): string[] {
  const written = JSON.stringify(args);
  return keys.filter((k) => !written.includes(sentinel(k)));
}

describe("every schema field reaches a column or the meta JSON", () => {
  test("asset upsert", () => {
    // Not written by the upsert: derived on read, or set by their own statements.
    const elsewhere = new Set(["currentVersion", "versionCount", "access", "spa"]);
    const keys = Object.keys(assetMetadataSchema.shape).filter((k) => !elsewhere.has(k));
    const args = assetUpsertArgs(sentinelModel(keys) as never);
    expect(droppedKeys(keys, args)).toEqual([]);
  });

  test("version insert", () => {
    const keys = Object.keys(assetVersionSchema.shape).filter((k) => k !== "version");
    const args = versionInsertArgs(sentinelModel(keys) as never);
    expect(droppedKeys(keys, args)).toEqual([]);
  });

  test("the extraction update rewrites every meta field the insert wrote", () => {
    const keys = Object.keys(assetVersionSchema.shape).filter((k) => k !== "version");
    const model = sentinelModel(keys) as never;
    const insertMeta = JSON.parse(String(versionInsertArgs(model)[8])) as Record<string, unknown>;
    const updateMeta = JSON.parse(String(versionExtractionUpdateArgs(model)[2])) as Record<string, unknown>;
    expect(Object.keys(updateMeta).sort()).toEqual(Object.keys(insertMeta).sort());
  });
});
