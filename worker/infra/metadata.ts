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

export class KVMetadataStore implements MetadataStore {
  constructor(private kv: KVNamespace) {}

  async save(asset: AssetMetadata, ttlSeconds: number): Promise<void> {
    await this.kv.put(`asset:${asset.id}`, JSON.stringify(asset), {
      expirationTtl: ttlSeconds,
    });
  }

  async find(id: string): Promise<AssetMetadata | null> {
    const raw = await this.kv.get(`asset:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as AssetMetadata;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`asset:${id}`);
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
  }

  async find(id: string): Promise<Job | null> {
    const raw = await this.kv.get(`job:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Job;
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`job:${id}`);
  }
}

export class KVProjectStore implements ProjectStore {
  constructor(private kv: KVNamespace) {}

  async save(project: Project): Promise<void> {
    await this.kv.put(`project:${project.id}`, JSON.stringify(project));

    // Update owner's project list
    await this.addToList(`project_list:${project.ownerId}`, project.id);

    // Update workspace's project list if applicable
    if (project.workspaceId) {
      await this.addToList(`project_list_ws:${project.workspaceId}`, project.id);
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
    await this.removeFromList(`project_list:${ownerId}`, id);

    // Remove from workspace's project list if applicable
    if (project?.workspaceId) {
      await this.removeFromList(`project_list_ws:${project.workspaceId}`, id);
    }
  }

  private async addToList(key: string, id: string): Promise<void> {
    const raw = await this.kv.get(key);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(id)) {
      ids.push(id);
      await this.kv.put(key, JSON.stringify(ids));
    }
  }

  private async removeFromList(key: string, id: string): Promise<void> {
    const raw = await this.kv.get(key);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      const filtered = ids.filter((i) => i !== id);
      await this.kv.put(key, JSON.stringify(filtered));
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
    await this.addToList(`member_list:${member.workspaceId}`, member.userId);

    // Update user's workspace list (inverse index)
    await this.addToList(`user_workspaces:${member.userId}`, member.workspaceId);
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
    await this.removeFromList(`member_list:${workspaceId}`, userId);

    // Remove from user's workspace list
    await this.removeFromList(`user_workspaces:${userId}`, workspaceId);
  }

  private async addToList(key: string, id: string): Promise<void> {
    const raw = await this.kv.get(key);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(id)) {
      ids.push(id);
      await this.kv.put(key, JSON.stringify(ids));
    }
  }

  private async removeFromList(key: string, id: string): Promise<void> {
    const raw = await this.kv.get(key);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      const filtered = ids.filter((i) => i !== id);
      await this.kv.put(key, JSON.stringify(filtered));
    }
  }
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
