import { describe, test, expect } from "vitest";
import { BASE, MOCK_OIDC, createProjectForAuth, signToken, uploadFileWithAuth } from "./helpers";

// Auto-detect if mock OIDC server is reachable (only available in local dev via e2e.sh).
// Auth tests that require token signing are skipped when mock OIDC is unavailable,
// since production uses a real IdP and mock-signed tokens would be rejected.
let mockOidcAvailable = false;
try {
  const res = await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`);
  mockOidcAvailable = res.ok;
} catch {
  // not reachable
}

describe("authentication", { skip: !mockOidcAvailable }, () => {
  test("health endpoint works without auth", async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid token → authenticated request succeeds", async () => {
    const token = await signToken({ sub: "user-1", email: "alice@example.com", name: "Alice" });
    const projectId = await createProjectForAuth(token, "auth-upload-test");
    const content = new TextEncoder().encode('{"hello":"world"}');
    const { status, body } = await uploadFileWithAuth(content, "test.json", "application/json", token, projectId);
    expect(status).toBe(201);
    expect(body.asset?.id).toBeDefined();
    expect(body.asset?.projectId).toBe(projectId);
  });

  test("authenticated upload without X-Project-Id → 400", async () => {
    const token = await signToken({ sub: "user-1" });
    const content = new TextEncoder().encode('{"x":1}');
    const { status } = await uploadFileWithAuth(content, "no-project.json", "application/json", token);
    expect(status).toBe(400);
  });

  test("authenticated upload with non-member X-Project-Id → 404", async () => {
    const ownerToken = await signToken({ sub: "owner-user" });
    const otherToken = await signToken({ sub: "other-user" });
    const projectId = await createProjectForAuth(ownerToken, "owner-project");

    const content = new TextEncoder().encode('{"x":1}');
    const { status } = await uploadFileWithAuth(content, "steal.json", "application/json", otherToken, projectId);
    expect(status).toBe(404);
  });

  test("expired token → 401", async () => {
    const token = await signToken({ expiresIn: "-1s" });
    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Filename": "test.json",
        "Authorization": `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("garbage token → 401", async () => {
    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Filename": "test.json",
        "Authorization": "Bearer not-a-real-jwt",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("invalid Authorization format → 401", async () => {
    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Filename": "test.json",
        "Authorization": "Basic abc123",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("no token → demo mode (request proceeds)", async () => {
    const content = new TextEncoder().encode('{"demo":"mode"}');
    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(content.byteLength),
        "X-Filename": "demo.json",
      },
      body: content,
    });
    // Demo mode upload should work (201)
    expect(res.status).toBe(201);
  });

  test("wrong audience → 401", async () => {
    const token = await signToken({ audience: "wrong-audience" });
    const res = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Filename": "test.json",
        "Authorization": `Bearer ${token}`,
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("project API (requires auth)", { skip: !mockOidcAvailable }, () => {
  test("list projects without auth → 401", async () => {
    const res = await fetch(`${BASE}/api/v1/projects`);
    expect(res.status).toBe(401);
  });

  test("create project without auth → 401", async () => {
    const res = await fetch(`${BASE}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-project" }),
    });
    expect(res.status).toBe(401);
  });

  test("project CRUD with valid token", async () => {
    const token = await signToken({ sub: "proj-user-1" });
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };

    // Create
    const createRes = await fetch(`${BASE}/api/v1/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "My E2E Project" }),
    });
    expect(createRes.status).toBe(201);
    const { project } = await createRes.json() as { project: { id: string; name: string; ownerId: string } };
    expect(project.name).toBe("My E2E Project");
    expect(project.ownerId).toBe("proj-user-1");

    // Get
    const getRes = await fetch(`${BASE}/api/v1/projects/${project.id}`, { headers });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json() as { project: { id: string; name: string } };
    expect(getBody.project.id).toBe(project.id);

    // List
    const listRes = await fetch(`${BASE}/api/v1/projects`, { headers });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { projects: { id: string }[] };
    expect(listBody.projects.some((p) => p.id === project.id)).toBe(true);

    // Delete
    const delRes = await fetch(`${BASE}/api/v1/projects/${project.id}`, {
      method: "DELETE",
      headers,
    });
    expect(delRes.status).toBe(204);

    // Verify deleted
    const afterDel = await fetch(`${BASE}/api/v1/projects/${project.id}`, { headers });
    expect(afterDel.status).toBe(404);
  });

  test("delete project by non-owner → 404", async () => {
    const ownerToken = await signToken({ sub: "owner-1" });
    const otherToken = await signToken({ sub: "other-1" });

    // Create as owner
    const createRes = await fetch(`${BASE}/api/v1/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ name: "Owner Project" }),
    });
    const { project } = await createRes.json() as { project: { id: string } };

    // Try delete as other user
    const delRes = await fetch(`${BASE}/api/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${otherToken}` },
    });
    expect(delRes.status).toBe(404);

    // Cleanup: delete as owner
    await fetch(`${BASE}/api/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${ownerToken}` },
    });
  });
});
