import { env } from "./env";

/**
 * Users bring their own LLM key. It is held here, in this process's memory, and
 * nowhere else: not the database, not Redis, not a log line, and never sent back
 * to a browser.
 *
 * It disappears when the user logs out, when it has sat for LLM_KEY_TTL_MS, and
 * whenever this process restarts. That last one is deliberate rather than a
 * limitation to fix: on a host that sleeps when idle, the key is gone by the time
 * the user returns, and they are asked for it again.
 */
export type LlmProvider = "gemini" | "groq";
export const LLM_PROVIDERS: readonly LlmProvider[] = ["gemini", "groq"];

export interface LlmCredential {
  provider: LlmProvider;
  apiKey: string;
}

interface Stored extends LlmCredential {
  expiresAt: number;
}

const store = new Map<string, Stored>();

/** Drop expired entries so an abandoned session does not keep a key around. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of store) {
    if (entry.expiresAt <= now) store.delete(userId);
  }
}, 60_000);
sweeper.unref();

export function setCredential(userId: string, credential: LlmCredential): { expiresAt: Date } {
  const expiresAt = Date.now() + env.LLM_KEY_TTL_MS;
  store.set(userId, { ...credential, expiresAt });
  return { expiresAt: new Date(expiresAt) };
}

export function getCredential(userId: string): LlmCredential | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(userId);
    return null;
  }
  return { provider: entry.provider, apiKey: entry.apiKey };
}

/** Which provider a user has set and until when. Never the key itself. */
export function credentialStatus(userId: string): { provider: LlmProvider; expiresAt: Date } | null {
  const entry = store.get(userId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { provider: entry.provider, expiresAt: new Date(entry.expiresAt) };
}

export function clearCredential(userId: string): void {
  store.delete(userId);
}

/** Test hook. */
export function clearAllCredentials(): void {
  store.clear();
}

/** Replace a key wherever it appears in text headed for a log or a response. */
export function redactKey(text: string, apiKey: string | undefined): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}
