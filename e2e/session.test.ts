import { describe, test, expect, beforeAll } from "vitest";
import { BASE } from "./helpers";

// Helper: generate a well-formed but server-unknown 16-char hex session ID
function generateSessionId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/**
 * Ask the server for a session. Since 100b9e9 the middleware only honors
 * X-Session-Id values it issued itself, so tests that need an owning session
 * must take one from the response header rather than inventing one.
 */
async function newSession(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/assets`);
  if (!res.ok) throw new Error(`Session mint failed: ${res.status}`);
  const id = res.headers.get("X-Session-Id");
  if (!id) throw new Error("Server did not issue a session ID");
  return id;
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

    test("Server-issued X-Session-Id → reused as-is", async () => {
      const sessionId = await newSession();
      const res = await fetch(`${BASE}/api/v1/assets`, {
        headers: { "X-Session-Id": sessionId },
      });
      expect(res.status).toBe(200);
      // Nothing minted: the server keeps the session it already issued.
      expect(res.headers.get("X-Session-Id")).toBeNull();
    });

    test("Well-formed but unknown X-Session-Id → not adopted, fresh one minted", async () => {
      const claimed = generateSessionId();
      const res = await fetch(`${BASE}/api/v1/assets`, {
        headers: { "X-Session-Id": claimed },
      });
      expect(res.status).toBe(200);
      const issued = res.headers.get("X-Session-Id");
      expect(issued).toMatch(/^[0-9a-f]{16}$/);
      expect(issued).not.toBe(claimed);
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
    let sessionA: string;
    let sessionB: string;
    let assetId: string;

    beforeAll(async () => {
      sessionA = await newSession();
      sessionB = await newSession();
    });

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
    let sessionA: string;
    let sessionB: string;
    let jobId: string;

    beforeAll(async () => {
      sessionA = await newSession();
      sessionB = await newSession();
    });

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
