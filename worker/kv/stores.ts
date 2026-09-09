import type { UploadSession } from "../asset/model";
import type { UploadSessionStore } from "../asset/repository";
import type { Session, SessionStore } from "../session/repository";
import type { KeyValue } from "./port";

/**
 * Stores whose whole job is "one JSON blob under one key, with a TTL".
 *
 * They are written against the `KeyValue` port (ADR-012 §2), so the same code
 * runs on Cloudflare KV, on the in-memory store in tests, and on the SQL-backed
 * store off Cloudflare. Key prefixes are unchanged from the KV-native versions
 * these replaced, so existing production entries keep resolving.
 */

export class KeyValueUploadSessionStore implements UploadSessionStore {
  constructor(private kv: KeyValue) {}

  async save(session: UploadSession, ttlSeconds: number): Promise<void> {
    await this.kv.put(`upload:${session.id}`, JSON.stringify(session), { ttlSeconds });
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

export class KeyValueSessionStore implements SessionStore {
  constructor(private kv: KeyValue) {}

  async save(session: Session, ttlSeconds: number): Promise<void> {
    await this.kv.put(`session:${session.id}`, JSON.stringify(session), { ttlSeconds });
  }

  async find(id: string): Promise<Session | null> {
    const raw = await this.kv.get(`session:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }
}
