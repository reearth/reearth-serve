import { describe, test, expect, beforeAll } from "vitest";
import { BASE } from "./helpers";

// Helper: generate a valid 16-char hex session ID
function generateSessionId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Helper: upload a file with a specific session
async function uploadWithSession(sessionId: string, filename: string, content: string) {
  const res = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(new TextEncoder().encode(content).byteLength),
      "X-Filename": filename,
      "X-Session-Id": sessionId,
    },
    body: content,
  });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}

describe("Session-based authorization", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  describe("Session ID management", () => {
    test("No X-Session-Id → server generates one and returns in header", async () => {
      const res = await fetch(`${BASE}/api/v1/assets`);
      expect(res.status).toBe(200);
      const sessionId = res.headers.get("X-Session-Id");
      expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    });

    test("Valid client-generated X-Session-Id → accepted", async () => {
      const sessionId = generateSessionId();
      const res = await fetch(`${BASE}/api/v1/assets`, {
        headers: { "X-Session-Id": sessionId },
      });
      expect(res.status).toBe(200);
    });

    test("Invalid X-Session-Id format → 401", async () => {
      const cases = ["short", "ABCDEF0123456789", "abcdef01234567890toolong", "!!invalid!!format"];
      for (const sid of cases) {
        const res = await fetch(`${BASE}/api/v1/assets`, {
          headers: { "X-Session-Id": sid },
        });
        expect(res.status).toBe(401);
      }
    });
  });

  describe("Asset isolation between sessions", () => {
    const sessionA = generateSessionId();
    const sessionB = generateSessionId();
    let assetId: string;

    test("Upload with session A", async () => {
      const { status, body } = await uploadWithSession(sessionA, "secret.txt", "session A data");
      expect(status).toBe(201);
      assetId = body.asset.id;
    });

    // NOTE: asset list relies on KV list which has eventual consistency (up to 60s).
    // We test session isolation via show/delete instead of list.

    test("Session B cannot list session A's asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets`, {
        headers: { "X-Session-Id": sessionB },
      });
      const body = await res.json() as any;
      expect(body.assets.some((a: any) => a.id === assetId)).toBe(false);
    });

    test("Session A can show own asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        headers: { "X-Session-Id": sessionA },
      });
      expect(res.status).toBe(200);
    });

    test("Session B gets 404 for session A's asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        headers: { "X-Session-Id": sessionB },
      });
      expect(res.status).toBe(404);
    });

    test("Session B cannot delete session A's asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        method: "DELETE",
        headers: { "X-Session-Id": sessionB },
      });
      expect(res.status).toBe(404);
    });

    test("File download works without session (URL is the secret)", async () => {
      const res = await fetch(`${BASE}/files/${assetId}/secret.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("session A data");
    });

    test("Session A can delete own asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        method: "DELETE",
        headers: { "X-Session-Id": sessionA },
      });
      expect(res.status).toBe(204);
    });
  });

  describe("Job isolation between sessions", () => {
    const sessionA = generateSessionId();
    const sessionB = generateSessionId();
    let jobId: string;

    test("Upload archive with session A → job created", async () => {
      const { status, body } = await uploadWithSession(sessionA, "test.zip", "PK\x03\x04fake");
      expect(status).toBe(201);
      expect(body.asset.jobId).toBeDefined();
      jobId = body.asset.jobId;
    });

    test("Session A can see own job", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs/${jobId}`, {
        headers: { "X-Session-Id": sessionA },
      });
      expect(res.status).toBe(200);
    });

    test("Session B gets 404 for session A's job", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs/${jobId}`, {
        headers: { "X-Session-Id": sessionB },
      });
      expect(res.status).toBe(404);
    });

    test("Session A can list own jobs", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs`, {
        headers: { "X-Session-Id": sessionA },
      });
      const body = await res.json() as any;
      expect(body.jobs.some((j: any) => j.id === jobId)).toBe(true);
    });

    test("Session B job list does not include session A's job", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs`, {
        headers: { "X-Session-Id": sessionB },
      });
      const body = await res.json() as any;
      expect(body.jobs.some((j: any) => j.id === jobId)).toBe(false);
    });
  });
});
