export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  save(session: Session, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<Session | null>;
}
