/** Convert camelCase key to snake_case */
export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Convert snake_case key to camelCase */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Convert a D1 row (snake_case columns + JSON meta) to a model object (camelCase).
 * The `meta` column is parsed and its fields are merged into the result.
 */
export function rowToModel<T>(row: Record<string, unknown>, metaKeys?: string[]): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "meta") continue;
    result[snakeToCamel(key)] = value;
  }
  // Merge meta fields
  if (row.meta && typeof row.meta === "string") {
    try {
      const meta = JSON.parse(row.meta) as Record<string, unknown>;
      for (const [key, value] of Object.entries(meta)) {
        if (value !== undefined && value !== null) {
          result[key] = value;
        }
      }
    } catch {
      // ignore malformed meta
    }
  }
  return result as T;
}

/**
 * Convert a model object (camelCase) to a D1 row (snake_case), omitting undefined values.
 * Fields listed in `metaKeys` are extracted into a JSON `meta` column.
 */
export function modelToRow(
  model: Record<string, unknown>,
  metaKeys?: string[],
): Record<string, unknown> {
  const metaSet = metaKeys ? new Set(metaKeys) : new Set<string>();
  const result: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(model)) {
    if (value === undefined) continue;
    if (metaSet.has(key)) {
      meta[key] = value;
    } else {
      result[camelToSnake(key)] = value;
    }
  }

  if (metaKeys) {
    result.meta = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
  }
  return result;
}

/** Encode a keyset cursor from created_at + id */
export function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`);
}

/** Decode a keyset cursor to { createdAt, id } */
export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const decoded = atob(cursor);
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    const createdAt = parseInt(decoded.slice(0, colonIdx), 10);
    const id = decoded.slice(colonIdx + 1);
    if (Number.isNaN(createdAt)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// --- Tests ---

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("camelToSnake", () => {
    expect(camelToSnake("createdAt")).toBe("created_at");
    expect(camelToSnake("projectId")).toBe("project_id");
    expect(camelToSnake("id")).toBe("id");
    expect(camelToSnake("contentEncoding")).toBe("content_encoding");
    expect(camelToSnake("extractedSize")).toBe("extracted_size");
  });

  test("snakeToCamel", () => {
    expect(snakeToCamel("created_at")).toBe("createdAt");
    expect(snakeToCamel("project_id")).toBe("projectId");
    expect(snakeToCamel("id")).toBe("id");
    expect(snakeToCamel("content_encoding")).toBe("contentEncoding");
  });

  test("rowToModel converts snake_case row to camelCase", () => {
    const row = { id: "a1", content_type: "text/plain", created_at: 123, project_id: null, meta: null };
    const model = rowToModel<{ id: string; contentType: string; createdAt: number; projectId: null }>(row);
    expect(model).toEqual({ id: "a1", contentType: "text/plain", createdAt: 123, projectId: null });
  });

  test("rowToModel merges meta fields", () => {
    const row = { id: "a1", content_type: "text/plain", meta: '{"contentEncoding":"gzip","fileCount":5}' };
    const model = rowToModel<{ id: string; contentType: string; contentEncoding: string; fileCount: number }>(row);
    expect(model.id).toBe("a1");
    expect(model.contentType).toBe("text/plain");
    expect(model.contentEncoding).toBe("gzip");
    expect(model.fileCount).toBe(5);
  });

  test("rowToModel handles null/missing meta", () => {
    const row = { id: "a1", meta: null };
    const model = rowToModel<{ id: string }>(row);
    expect(model.id).toBe("a1");
  });

  test("modelToRow converts camelCase to snake_case, omitting undefined", () => {
    const model = { id: "a1", contentType: "text/plain", createdAt: 123, projectId: undefined };
    const row = modelToRow(model);
    expect(row).toEqual({ id: "a1", content_type: "text/plain", created_at: 123 });
  });

  test("modelToRow extracts metaKeys into JSON meta column", () => {
    const model = { id: "a1", filename: "f.txt", contentEncoding: "gzip", fileCount: 5, jobId: "j1" };
    const row = modelToRow(model, ["contentEncoding", "fileCount", "jobId"]);
    expect(row.id).toBe("a1");
    expect(row.filename).toBe("f.txt");
    expect(row.content_encoding).toBeUndefined();
    expect(row.file_count).toBeUndefined();
    const meta = JSON.parse(row.meta as string);
    expect(meta).toEqual({ contentEncoding: "gzip", fileCount: 5, jobId: "j1" });
  });

  test("modelToRow sets meta to null when no meta fields have values", () => {
    const model = { id: "a1" };
    const row = modelToRow(model, ["contentEncoding"]);
    expect(row.meta).toBeNull();
  });

  test("encodeCursor / decodeCursor roundtrip", () => {
    const cursor = encodeCursor(1710000000000, "abc123");
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ createdAt: 1710000000000, id: "abc123" });
  });

  test("decodeCursor returns null for invalid input", () => {
    expect(decodeCursor("invalid-base64!!!")).toBeNull();
    expect(decodeCursor(btoa("no-colon"))).toBeNull();
    expect(decodeCursor(btoa("notanumber:id"))).toBeNull();
  });
}
