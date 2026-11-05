import { beforeAll, describe, expect, test } from "vitest";
import { BASE, signToken, uploadFile, uploadFileWithAuth } from "./helpers";
import {
  ACCOUNTS_LOG, PHASE, accounts, accountsReachable, accountsRequestLines,
  seedWorkspace, signupUser, subOf, teamAlias, type AccountsUser,
} from "./accounts-helpers";

const accountsUp = await accountsReachable();
const serveUp = await fetch(`${BASE}/api/v1/health`).then((r) => r.ok, () => false);

const TEAM = "serve-e2e-team";
const NAMES = ["alice", "mara", "will", "rita", "dave"] as const;
type Name = (typeof NAMES)[number];
const label = (name: Name | "nobody") => `serve-${name}`;
const BYTES = new TextEncoder().encode("hello");

async function tokenOf(name: Name | "nobody"): Promise<string> {
  const sub = subOf(label(name));
  return signToken({ sub, email: `${sub}@example.com`, name: sub });
}

async function serve(name: Name | "nobody", method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tokenOf(name)}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

async function upload(name: Name, projectId: string): Promise<{ status: number; id?: string }> {
  const { status, body } = await uploadFileWithAuth(BYTES, "hello.txt", "text/plain", await tokenOf(name), projectId);
  return { status, id: body?.asset?.id };
}

async function claimHost(name: Name, assetId: string | undefined) {
  return serve(name, "POST", `/assets/${assetId}/hosts`, { hostname: `${name}-${Date.now()}` });
}

async function teamWorkspaceId(name: Name): Promise<string> {
  const { body } = await serve(name, "GET", "/me");
  const team = body.workspaces.find((w: { name: string }) => w.name.startsWith(teamAlias(TEAM)));
  if (!team) throw new Error(`${name} sees no team workspace`);
  return team.id;
}

async function createProject(name: Name, workspaceId: string) {
  return serve(name, "POST", "/projects", { name: `p-${Date.now()}`, workspaceId });
}

describe.runIf(accountsUp && serveUp && PHASE === "fresh")("Serve with ACCOUNTS_URL", () => {
  const users = {} as Record<Name, AccountsUser>;
  let workspaceId = "";
  let teamProject = "";

  beforeAll(async () => {
    for (const name of NAMES) users[name] = await signupUser(label(name));
    workspaceId = await seedWorkspace(users.alice, [
      { user: users.mara, role: "maintainer" },
      { user: users.will, role: "writer" },
      { user: users.rita, role: "reader" },
    ], teamAlias(TEAM));
    const created = await createProject("alice", workspaceId);
    expect(created.status).toBe(201);
    teamProject = created.body.project.id;
  }, 60_000);

  test("GET /me lists the team workspace with the mapped role and the personal workspace as owner", async () => {
    const { status, body } = await serve("rita", "GET", "/me");
    expect(status).toBe(200);
    expect(body.user.sub).toBe(subOf(label("rita")));
    const roles = Object.fromEntries(body.workspaces.map((w: { id: string; role: string }) => [w.id, w.role]));
    expect(roles[workspaceId]).toBe("viewer");
    expect(Object.entries(roles).filter(([id, role]) => id !== workspaceId && role === "owner")).toHaveLength(1);
  });

  test("a writer uploads into a team project and a reader gets 404", async () => {
    expect((await upload("will", teamProject)).status).toBe(201);
    expect((await upload("rita", teamProject)).status).toBe(404);
  });

  test("a writer updates an asset and a reader gets 404", async () => {
    const { id } = await upload("will", teamProject);
    expect((await serve("will", "PATCH", `/assets/${id}`, { description: "by will" })).status).toBe(200);
    expect((await serve("rita", "PATCH", `/assets/${id}`, { description: "by rita" })).status).toBe(404);
  });

  test("a reader lists the team's assets by workspace, and a non-member gets 404", async () => {
    const { id } = await upload("will", teamProject);
    const listed = await serve("rita", "GET", `/assets?workspaceId=${workspaceId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.assets.map((a: { id: string }) => a.id)).toContain(id);
    expect((await serve("dave", "GET", `/assets?workspaceId=${workspaceId}`)).status).toBe(404);
  });

  test("an unscoped asset list covers every workspace the caller belongs to", async () => {
    const team = await upload("will", teamProject);
    const personalWorkspace = (await serve("will", "GET", "/me")).body.workspaces
      .find((w: { id: string; role: string }) => w.id !== workspaceId && w.role === "owner").id;
    const personalProject = (await createProject("will", personalWorkspace)).body.project.id;
    const personal = await upload("will", personalProject);
    const ids = (await serve("will", "GET", "/assets")).body.assets.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([team.id, personal.id]));
  });

  test("project create in the team workspace: maintainer 201, writer 403, non-member 404", async () => {
    expect((await createProject("mara", workspaceId)).status).toBe(201);
    expect((await createProject("will", workspaceId)).status).toBe(403);
    expect((await createProject("dave", workspaceId)).status).toBe(404);
  });

  test("project create without a workspace answers 400", async () => {
    expect(await serve("alice", "POST", "/projects", { name: "ownerless" })).toMatchObject({
      status: 400, body: { error: "workspaceId is required" },
    });
  });

  test("project delete stays with the owner: maintainer and writer 404, owner 204", async () => {
    const doomed = (await createProject("alice", workspaceId)).body.project.id;
    expect((await serve("mara", "DELETE", `/projects/${doomed}`)).status).toBe(404);
    expect((await serve("will", "DELETE", `/projects/${doomed}`)).status).toBe(404);
    expect((await serve("alice", "DELETE", `/projects/${doomed}`)).status).toBe(204);
  });

  test("workspace and member writes answer 405 for everyone", async () => {
    const writes: [string, string, unknown?][] = [
      ["POST", "/workspaces", { name: "x" }],
      ["DELETE", `/workspaces/${workspaceId}`],
      ["POST", `/workspaces/${workspaceId}/members`, { userId: users.dave.id, role: "viewer" }],
      ["PATCH", `/workspaces/${workspaceId}/members/${users.rita.id}`, { role: "editor" }],
      ["DELETE", `/workspaces/${workspaceId}/members/${users.rita.id}`],
    ];
    for (const name of NAMES) {
      for (const [method, path, body] of writes) {
        expect({ name, method, path, ...(await serve(name, method, path, body)) }).toMatchObject({
          name, method, path, status: 405,
          body: { error: "Workspaces and members are managed by an external directory" },
        });
      }
    }
  });

  test("a valid token with no directory user answers the neutral 401", async () => {
    for (const path of ["/me", `/projects/${teamProject}`]) {
      expect(await serve("nobody", "GET", path)).toMatchObject({
        status: 401, body: { error: "No directory user is linked to this identity" },
      });
    }
  });

  test.runIf(ACCOUNTS_LOG)("a warm project-scoped request costs one membership read and one check", async () => {
    await upload("will", teamProject);
    const before = (await accountsRequestLines()).length;
    expect((await upload("will", teamProject)).status).toBe(201);
    const lines = (await accountsRequestLines()).slice(before);
    expect(lines.sort()).toEqual(["<-- GET /api/workspaces", "<-- POST /api/permissions/check"]);
  });

  test("manage_hosts: a writer passes authorization and meets the site hosts switch, a reader gets 404", async () => {
    const { id } = await upload("will", teamProject);
    expect(await claimHost("will", id)).toMatchObject({ status: 503, body: { error: "site hosts are not enabled on this server" } });
    expect((await claimHost("rita", id)).status).toBe(404);
  });

  test.runIf(ACCOUNTS_LOG)("a warm manage_hosts request costs one membership read and one check", async () => {
    const { id } = await upload("will", teamProject);
    const before = (await accountsRequestLines()).length;
    expect((await claimHost("will", id)).status).toBe(503);
    const lines = (await accountsRequestLines()).slice(before);
    expect(lines.sort()).toEqual(["<-- GET /api/workspaces", "<-- POST /api/permissions/check"]);
  });

  test("a member removed in accounts loses access on the next request", async () => {
    expect((await upload("will", teamProject)).status).toBe(201);
    await accounts("DELETE", `/api/workspaces/${workspaceId}/members/${users.will.id}`, undefined, users.alice.sub);
    expect((await upload("will", teamProject)).status).toBe(404);
  });

  test("a workspace alias renamed in accounts keeps checks working on the next request", async () => {
    await accounts("PATCH", `/api/workspaces/${workspaceId}`, { alias: `${teamAlias(TEAM)}-renamed` }, users.alice.sub);
    expect((await upload("mara", teamProject)).status).toBe(201);
  });
});

describe.runIf(accountsUp && serveUp && PHASE === "migrated")("Serve after the accounts role migration", () => {
  test("a reader holding a global maintainer role still cannot create a project", async () => {
    const workspaceId = await teamWorkspaceId("rita");
    expect((await createProject("rita", workspaceId)).status).toBe(403);
  });
});

describe.runIf(accountsUp && serveUp && PHASE === "down")("Serve while accounts is down", () => {
  let teamProject = "";
  let file = "";

  beforeAll(async () => {
    const workspaceId = await teamWorkspaceId("alice");
    teamProject = (await serve("alice", "GET", `/projects?workspaceId=${workspaceId}`)).body.projects[0].id;
    const anonymous = await uploadFile(BYTES, "public.txt", "text/plain");
    file = `/files/${anonymous.body.asset.id}/public.txt`;
    const pid = Number(process.env.E2E_ACCOUNTS_PID);
    if (!pid) throw new Error("E2E_ACCOUNTS_PID is required to stop accounts");
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && (await accountsReachable()); i++) await new Promise((r) => setTimeout(r, 250));
    expect(await accountsReachable()).toBe(false);
  }, 30_000);

  test("signed-in routes answer 503 with Retry-After", async () => {
    for (const path of [`/projects/${teamProject}`, "/me"]) {
      const res = await serve("alice", "GET", path);
      expect(res).toMatchObject({ status: 503, body: { error: "Authorization service unavailable" } });
      expect(res.headers.get("Retry-After")).toBe("5");
    }
  });

  test("an anonymous upload and a public file read still work", async () => {
    expect((await uploadFile(BYTES, "still.txt", "text/plain")).status).toBe(201);
    const res = await fetch(`${BASE}${file}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});
