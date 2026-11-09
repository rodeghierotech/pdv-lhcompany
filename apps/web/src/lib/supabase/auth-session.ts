import { readSupabasePublicConfig } from "./config";

const STORAGE_KEY = "lh-company.supabase-session";

export type AuthSession = {
  accessToken: string;
  expiresAt: number;
  userId: string;
};

type AuthResponse = {
  access_token?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown };
};

export function parseAuthSession(value: AuthResponse, now: number): AuthSession | undefined {
  if (typeof value.access_token !== "string" || typeof value.expires_at !== "number" || typeof value.user?.id !== "string") {
    return undefined;
  }

  const expiresAt = value.expires_at * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;

  return { accessToken: value.access_token, expiresAt, userId: value.user.id };
}

export function readStoredSession(storage: Storage, now = Date.now()): AuthSession | undefined {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const session = JSON.parse(raw) as AuthSession;
    if (typeof session.accessToken !== "string" || typeof session.userId !== "string" || typeof session.expiresAt !== "number" || session.expiresAt <= now) {
      storage.removeItem(STORAGE_KEY);
      return undefined;
    }
    return session;
  } catch {
    storage.removeItem(STORAGE_KEY);
    return undefined;
  }
}

export function clearStoredSession(storage: Storage) {
  storage.removeItem(STORAGE_KEY);
}

export async function signInWithPassword(input: { email: string; password: string; storage: Storage }): Promise<AuthSession> {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de entrar.");

  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: config.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.email.trim(), password: input.password }),
  });
  const responseBody = await response.json().catch(() => ({}));
  const session = parseAuthSession(responseBody, Date.now());
  if (!response.ok || !session) throw new Error("Não foi possível iniciar a sessão. Confira e-mail e senha.");

  input.storage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export async function fetchOrganizationId(session: AuthSession): Promise<string> {
  const config = readSupabasePublicConfig(import.meta.env);
  if (config.status !== "ready") throw new Error("Configure o Supabase antes de consultar a organização.");

  const response = await fetch(`${config.url}/rest/v1/organization_member?select=organization_id&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` },
  });
  const memberships = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(memberships) || typeof memberships[0]?.organization_id !== "string") {
    throw new Error("Seu usuário não está associado a uma organização.");
  }
  return memberships[0].organization_id;
}
