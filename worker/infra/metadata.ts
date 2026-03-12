import type { AssetMetadata, UploadSession } from "../asset/model";
import type { MetadataStore, UploadSessionStore } from "../asset/repository";
import type { Job } from "../job/model";
import type { JobStore } from "../job/repository";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import type { Session, SessionStore } from "../session/repository";

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
    const listKey = `project_list:${project.ownerId}`;
    const raw = await this.kv.get(listKey);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(project.id)) {
      ids.push(project.id);
      await this.kv.put(listKey, JSON.stringify(ids));
    }
  }

  async find(id: string): Promise<Project | null> {
    const raw = await this.kv.get(`project:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Project;
  }

  async list(ownerId: string): Promise<Project[]> {
    const raw = await this.kv.get(`project_list:${ownerId}`);
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
    await this.kv.delete(`project:${id}`);

    // Remove from owner's project list
    const listKey = `project_list:${ownerId}`;
    const raw = await this.kv.get(listKey);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      const filtered = ids.filter((i) => i !== id);
      await this.kv.put(listKey, JSON.stringify(filtered));
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
