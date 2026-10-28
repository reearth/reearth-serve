import { describe, test, expect, beforeAll } from "vitest";
import { BASE } from "./helpers";

describe("Error handling", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  test("GET /api/v1/assets/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("GET /files/nonexistent/x.txt returns 404", async () => {
    const res = await fetch(`${BASE}/files/nonexistent/x.txt`);
    expect(res.status).toBe(404);
  });

  test("POST /api/v1/assets without file field returns 400", async () => {
    const form = new FormData();
    const res = await fetch(`${BASE}/api/v1/assets`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  test("DELETE /api/v1/assets/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/nonexistent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("filenames that would escape the asset prefix are rejected", async () => {
    const session = await fetch(`${BASE}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "../victim/data.geojson", size: 10 }),
    });
    expect(session.status).toBe(400);

    const direct = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: { "X-Filename": "../victim/data.geojson", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(direct.status).toBe(400);
  });
});
