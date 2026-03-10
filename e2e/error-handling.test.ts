import { describe, test, expect, beforeAll } from "vitest";
import { BASE } from "./helpers";

describe("Error handling", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  test("GET /assets/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/assets/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("GET /files/nonexistent/x.txt returns 404", async () => {
    const res = await fetch(`${BASE}/files/nonexistent/x.txt`);
    expect(res.status).toBe(404);
  });

  test("POST /assets without file field returns 400", async () => {
    const form = new FormData();
    const res = await fetch(`${BASE}/assets`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  test("DELETE /assets/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/assets/nonexistent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
