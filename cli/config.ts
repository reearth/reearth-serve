import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.REEARTH_SERVE_CONFIG_DIR ?? join(homedir(), ".config", "reearth-serve");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

export interface Config {
  endpoint?: string;
  oidcIssuer?: string;
  clientId?: string;
  defaultProject?: string;
  defaultWorkspace?: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config;
}

export function saveConfig(config: Config): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as Credentials;
  // Check if token has expired
  if (creds.expiresAt && Date.now() > creds.expiresAt) {
    return null;
  }
  return creds;
}

export function saveCredentials(creds: Credentials): void {
  ensureDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    writeFileSync(CREDENTIALS_FILE, "");
  }
}

export function loadSessionId(): string | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as { sessionId?: string };
    return data.sessionId ?? null;
  } catch {
    return null;
  }
}

export function saveSessionId(sessionId: string): void {
  ensureDir();
  writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }) + "\n");
}

/** Load existing session ID, or generate and persist a new one. */
export function loadOrCreateSessionId(): string {
  const existing = loadSessionId();
  if (existing) return existing;
  const id = randomBytes(8).toString("hex");
  saveSessionId(id);
  return id;
}

