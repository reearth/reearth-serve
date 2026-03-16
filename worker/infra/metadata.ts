import type { AssetMetadata, UploadSession } from "../asset/model";
import type { MetadataStore, UploadSessionStore } from "../asset/repository";
import type { Job } from "../job/model";
import type { JobStore } from "../job/repository";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import type { Session, SessionStore } from "../session/repository";
import type { Workspace } from "../workspace/model";
import type { WorkspaceStore } from "../workspace/repository";
import type { Member } from "../member/model";
import type { MemberStore } from "../member/repository";

// Shared index list helpers

async function addToList(kv: KVNamespace, key: string, id: string): Promise<void> {
  const raw = await kv.get(key);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(id)) {
    ids.push(id);
    await kv.put(key, JSON.stringify(ids));
  }
}

async function removeFromList(kv: KVNamespace, key: string, id: string): Promise<void> {
  const raw = await kv.get(key);
  if (raw) {
    const ids: string[] = JSON.parse(raw);
    const filtered = ids.filter((i) => i !== id);
    await kv.put(key, JSON.stringify(filtered));
  }
}

async function listFromIndex<T>(
  kv: KVNamespace,
  listKey: string,
  fetchOne: (id: string) => Promise<T | null>,
  options?: { limit?: number; cursor?: string },
): Promise<{ items: T[]; cursor?: string }> {
  const limit = options?.limit ?? 20;
  const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;

  const raw = await kv.get(listKey);
  if (!raw) return { items: [] };
  const allIds: string[] = JSON.parse(raw);

  const items: T[] = [];
  let pos = offset;

  // Fetch in parallel batches to reduce waterfall latency
  while (items.length < limit && pos < allIds.length) {
    const batchSize = Math.min(limit - items.length + 5, allIds.length - pos);
    const batchIds = allIds.slice(pos, pos + batchSize);
    const results = await Promise.all(batchIds.map(fetchOne));
    for (let i = 0; i < results.length; i++) {
      pos++;
      const item = results[i];
      if (!item) continue; // stale/expired — skip
      items.push(item);
      if (items.length >= limit) break;
    }
  }

  const cursor = pos < allIds.length ? String(pos) : undefined;
  return { items, cursor };
}

export class KVMetadataStore implements MetadataStore {
  constructor(private kv: KVNamespace) {}

  async save(asset: AssetMetadata, ttlSeconds: number): Promise<void> {
    await this.kv.put(`asset:${asset.id}`, JSON.stringify(asset), {
      expirationTtl: ttlSeconds,
    });
    await addToList(this.kv, "asset_list:all", asset.id);
    if (asset.sessionId) {
      await addToList(this.kv, `asset_list:session:${asset.sessionId}`, asset.id);
    }
    if (asset.projectId) {
      await addToList(this.kv, `asset_list:project:${asset.projectId}`, asset.id);
    }
  }

  async find(id: string): Promise<AssetMetadata | null> {
    const raw = await this.kv.get(`asset:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as AssetMetadata;
  }

  async delete(id: string): Promise<void> {
    // Read before delete to discover index keys
    const asset = await this.find(id);
    await this.kv.delete(`asset:${id}`);
    await removeFromList(this.kv, "asset_list:all", id);
    if (asset?.sessionId) {
      await removeFromList(this.kv, `asset_list:session:${asset.sessionId}`, id);
    }
    if (asset?.projectId) {
      await removeFromList(this.kv, `asset_list:project:${asset.projectId}`, id);
    }
  }

  async list(options?: { limit?: number; cursor?: string; sessionId?: string; projectId?: string }): Promise<{ items: AssetMetadata[]; cursor?: string }> {
    const { sessionId, projectId } = options ?? {};
    let listKey: string;
    if (sessionId) {
      listKey = `asset_list:session:${sessionId}`;
    } else if (projectId) {
      listKey = `asset_list:project:${projectId}`;
    } else {
      listKey = "asset_list:all";
    }
    return listFromIndex(this.kv, listKey, (id) => this.find(id), options);
  }
}

export class KVUploadSessionStore implements UploadSessionStore {
  constructor(private kv: KVNamespace) {}

  async save(session: UploadSession, ttlSeconds: number): Promise<void> {
    await this.kv.put(`upload:${session.id}`, JSON.stringify(session), {
      expirationTtl: ttlSeconds,
    });
  }

  async find(id: string): Promise<UploadSession | null> {
    const raw = await this.kv.get(`upload:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as UploadSession;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`upload:${id}`);
  }
}

export class KVJobStore implements JobStore {
  constructor(private kv: KVNamespace) {}

  async save(job: Job): Promise<void> {
    await this.kv.put(`job:${job.id}`, JSON.stringify(job));
    await addToList(this.kv, "job_list:all", job.id);
    if (job.sessionId) {
      await addToList(this.kv, `job_list:session:${job.sessionId}`, job.id);
    }
    if (job.projectId) {
      await addToList(this.kv, `job_list:project:${job.projectId}`, job.id);
    }
  }

  async find(id: string): Promise<Job | null> {
    const raw = await this.kv.get(`job:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Job;
  }

  async delete(id: string): Promise<void> {
    const job = await this.find(id);
    await this.kv.delete(`job:${id}`);
    await removeFromList(this.kv, "job_list:all", id);
    if (job?.sessionId) {
      await removeFromList(this.kv, `job_list:session:${job.sessionId}`, id);
    }
    if (job?.projectId) {
      await removeFromList(this.kv, `job_list:project:${job.projectId}`, id);
    }
  }

  async list(options?: { limit?: number; cursor?: string; sessionId?: string; projectId?: string }): Promise<{ items: Job[]; cursor?: string }> {
    const { sessionId, projectId } = options ?? {};
    let listKey: string;
    if (sessionId) {
      listKey = `job_list:session:${sessionId}`;
    } else if (projectId) {
      listKey = `job_list:project:${projectId}`;
    } else {
      listKey = "job_list:all";
    }
    return listFromIndex(this.kv, listKey, (id) => this.find(id), options);
  }
}

export class KVProjectStore implements ProjectStore {
  constructor(private kv: KVNamespace) {}

  async save(project: Project): Promise<void> {
    await this.kv.put(`project:${project.id}`, JSON.stringify(project));

    // Update owner's project list
    await addToList(this.kv, `project_list:${project.ownerId}`, project.id);

    // Update workspace's project list if applicable
    if (project.workspaceId) {
      await addToList(this.kv, `project_list_ws:${project.workspaceId}`, project.id);
    }
  }

  async find(id: string): Promise<Project | null> {
    const raw = await this.kv.get(`project:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Project;
  }

  async list(params: { ownerId?: string; workspaceId?: string }): Promise<Project[]> {
    let listKey: string;
    if (params.workspaceId) {
      listKey = `project_list_ws:${params.workspaceId}`;
    } else if (params.ownerId) {
      listKey = `project_list:${params.ownerId}`;
    } else {
      return [];
    }

    const raw = await this.kv.get(listKey);
    if (!raw) return [];
    const ids: string[] = JSON.parse(raw);

    const projects: Project[] = [];
    for (const id of ids) {
      const project = await this.find(id);
      if (project) projects.push(project);
    }
    return projects;
  }

  async delete(id: string, ownerId: string): Promise<void> {
    // Read project to get workspaceId before deleting
    const project = await this.find(id);

    await this.kv.delete(`project:${id}`);

    // Remove from owner's project list
    await removeFromList(this.kv, `project_list:${ownerId}`, id);

    // Remove from workspace's project list if applicable
    if (project?.workspaceId) {
      await removeFromList(this.kv, `project_list_ws:${project.workspaceId}`, id);
    }
  }
}

export class KVWorkspaceStore implements WorkspaceStore {
  constructor(private kv: KVNamespace) {}

  async save(workspace: Workspace): Promise<void> {
    await this.kv.put(`workspace:${workspace.id}`, JSON.stringify(workspace));
  }

  async find(id: string): Promise<Workspace | null> {
    const raw = await this.kv.get(`workspace:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Workspace;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`workspace:${id}`);
  }
}

export class KVMemberStore implements MemberStore {
  constructor(private kv: KVNamespace) {}

  async save(member: Member): Promise<void> {
    await this.kv.put(
      `member:${member.workspaceId}:${member.userId}`,
      JSON.stringify(member),
    );

    // Update workspace's member list
    await addToList(this.kv, `member_list:${member.workspaceId}`, member.userId);

    // Update user's workspace list (inverse index)
    await addToList(this.kv, `user_workspaces:${member.userId}`, member.workspaceId);
  }

  async find(workspaceId: string, userId: string): Promise<Member | null> {
    const raw = await this.kv.get(`member:${workspaceId}:${userId}`);
    if (!raw) return null;
    return JSON.parse(raw) as Member;
  }

  async list(workspaceId: string): Promise<Member[]> {
    const raw = await this.kv.get(`member_list:${workspaceId}`);
    if (!raw) return [];
    const userIds: string[] = JSON.parse(raw);

    const members: Member[] = [];
    for (const userId of userIds) {
      const member = await this.find(workspaceId, userId);
      if (member) members.push(member);
    }
    return members;
  }

  async listByUser(userId: string): Promise<Member[]> {
    const raw = await this.kv.get(`user_workspaces:${userId}`);
    if (!raw) return [];
    const wsIds: string[] = JSON.parse(raw);

    const members: Member[] = [];
    for (const wsId of wsIds) {
      const member = await this.find(wsId, userId);
      if (member) members.push(member);
    }
    return members;
  }

  async delete(workspaceId: string, userId: string): Promise<void> {
    await this.kv.delete(`member:${workspaceId}:${userId}`);

    // Remove from workspace's member list
    await removeFromList(this.kv, `member_list:${workspaceId}`, userId);

    // Remove from user's workspace list
    await removeFromList(this.kv, `user_workspaces:${userId}`, workspaceId);
  }
}

// --- Tests for index-based stores ---

if (import.meta.vitest) {
  const { test, expect, beforeEach } = import.meta.vitest;

  function mockKV(): KVNamespace & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      _store: store,
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace & { _store: Map<string, string> };
  }

  function makeAsset(id: string, opts?: { sessionId?: string; projectId?: string }): AssetMetadata {
    return {
      id,
      filename: `${id}.bin`,
      contentType: "application/octet-stream",
      size: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      ...opts,
    };
  }

  function makeJob(id: string, opts?: { sessionId?: string; projectId?: string }): Job {
    return {
      id,
      assetId: `asset-${id}`,
      type: "archive-extraction",
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...opts,
    };
  }

  // --- KVMetadataStore tests ---

  test("save adds asset to all index", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    const asset = makeAsset("a1");
    await store.save(asset, 3600);

    const raw = kv._store.get("asset_list:all");
    expect(JSON.parse(raw!)).toEqual(["a1"]);
  });

  test("save adds asset to session and project indices", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    const asset = makeAsset("a1", { sessionId: "s1", projectId: "p1" });
    await store.save(asset, 3600);

    expect(JSON.parse(kv._store.get("asset_list:session:s1")!)).toEqual(["a1"]);
    expect(JSON.parse(kv._store.get("asset_list:project:p1")!)).toEqual(["a1"]);
  });

  test("save is idempotent for indices on re-save", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    const asset = makeAsset("a1");
    await store.save(asset, 3600);
    await store.save(asset, 3600);

    expect(JSON.parse(kv._store.get("asset_list:all")!)).toEqual(["a1"]);
  });

  test("delete removes asset from all indices", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    const asset = makeAsset("a1", { sessionId: "s1", projectId: "p1" });
    await store.save(asset, 3600);
    await store.delete("a1");

    expect(await store.find("a1")).toBeNull();
    expect(JSON.parse(kv._store.get("asset_list:all")!)).toEqual([]);
    expect(JSON.parse(kv._store.get("asset_list:session:s1")!)).toEqual([]);
    expect(JSON.parse(kv._store.get("asset_list:project:p1")!)).toEqual([]);
  });

  test("list returns all assets", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    await store.save(makeAsset("a1"), 3600);
    await store.save(makeAsset("a2"), 3600);

    const result = await store.list();
    expect(result.items).toHaveLength(2);
    expect(result.items.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  test("list filters by sessionId", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    await store.save(makeAsset("a1", { sessionId: "s1" }), 3600);
    await store.save(makeAsset("a2", { sessionId: "s2" }), 3600);

    const result = await store.list({ sessionId: "s1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a1");
  });

  test("list filters by projectId", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    await store.save(makeAsset("a1", { projectId: "p1" }), 3600);
    await store.save(makeAsset("a2", { projectId: "p2" }), 3600);

    const result = await store.list({ projectId: "p1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a1");
  });

  test("list paginates with offset cursor", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    for (let i = 0; i < 5; i++) {
      await store.save(makeAsset(`a${i}`), 3600);
    }

    const page1 = await store.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.cursor).toBeDefined();

    const page2 = await store.list({ limit: 2, cursor: page1.cursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.cursor).toBeDefined();

    const page3 = await store.list({ limit: 2, cursor: page2.cursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.cursor).toBeUndefined();
  });

  test("list skips stale/expired entries", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);
    await store.save(makeAsset("a1"), 3600);
    await store.save(makeAsset("a2"), 3600);
    // Simulate a2 expiring from KV (remove the data key but leave index)
    kv._store.delete("asset:a2");

    const result = await store.list();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a1");
  });

  test("list returns empty for no index", async () => {
    const kv = mockKV();
    const store = new KVMetadataStore(kv);

    const result = await store.list();
    expect(result.items).toEqual([]);
  });

  // --- KVJobStore tests ---

  test("job save adds to all index", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1"));

    expect(JSON.parse(kv._store.get("job_list:all")!)).toEqual(["j1"]);
  });

  test("job save adds to session and project indices", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1", { sessionId: "s1", projectId: "p1" }));

    expect(JSON.parse(kv._store.get("job_list:session:s1")!)).toEqual(["j1"]);
    expect(JSON.parse(kv._store.get("job_list:project:p1")!)).toEqual(["j1"]);
  });

  test("job delete removes from all indices", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1", { sessionId: "s1", projectId: "p1" }));
    await store.delete("j1");

    expect(await store.find("j1")).toBeNull();
    expect(JSON.parse(kv._store.get("job_list:all")!)).toEqual([]);
    expect(JSON.parse(kv._store.get("job_list:session:s1")!)).toEqual([]);
    expect(JSON.parse(kv._store.get("job_list:project:p1")!)).toEqual([]);
  });

  test("job list returns all jobs", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1"));
    await store.save(makeJob("j2"));

    const result = await store.list();
    expect(result.items).toHaveLength(2);
  });

  test("job list filters by sessionId", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1", { sessionId: "s1" }));
    await store.save(makeJob("j2", { sessionId: "s2" }));

    const result = await store.list({ sessionId: "s1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("j1");
  });

  test("job list paginates with offset cursor", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    for (let i = 0; i < 5; i++) {
      await store.save(makeJob(`j${i}`));
    }

    const page1 = await store.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.cursor).toBeDefined();

    const page2 = await store.list({ limit: 2, cursor: page1.cursor });
    expect(page2.items).toHaveLength(2);

    const page3 = await store.list({ limit: 2, cursor: page2.cursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.cursor).toBeUndefined();
  });

  test("job list skips stale entries", async () => {
    const kv = mockKV();
    const store = new KVJobStore(kv);
    await store.save(makeJob("j1"));
    await store.save(makeJob("j2"));
    kv._store.delete("job:j2");

    const result = await store.list();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("j1");
  });
}

export class KVSessionStore implements SessionStore {
  constructor(private kv: KVNamespace) {}

  async save(session: Session, ttlSeconds: number): Promise<void> {
    await this.kv.put(`session:${session.id}`, JSON.stringify(session), {
      expirationTtl: ttlSeconds,
    });
  }

  async find(id: string): Promise<Session | null> {
    const raw = await this.kv.get(`session:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }
}
