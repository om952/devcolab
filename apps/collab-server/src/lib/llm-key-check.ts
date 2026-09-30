import { env } from "./env";
import type { LlmProvider } from "./llm-credentials";

export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: "rejected" | "unreachable"; message: string };

const ENDPOINTS: Record<LlmProvider, (key: string) => { url: string; headers: Record<string, string> }> = {
  // Listing models costs nothing and needs a valid key, unlike a real completion.
  gemini: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: { "x-goog-api-key": key },
  }),
  groq: (key) => ({
    url: "https://api.groq.com/openai/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
};

const LABELS: Record<LlmProvider, string> = { gemini: "Gemini", groq: "Groq" };

/**
 * Ask the provider whether a key works, so a typo is caught when it is entered
 * rather than minutes later when four agents each fail with it.
 *
 * A 429 counts as valid: the provider only rate limits keys it recognises.
 */
export async function checkKeyWithProvider(provider: LlmProvider, apiKey: string): Promise<KeyCheck> {
  if (env.LLM_KEY_CHECK === "skip") return { ok: true };

  const { url, headers } = ENDPOINTS[provider](apiKey);
  const label = LABELS[provider];

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, reason: "unreachable", message: `Could not reach ${label} to check the key. Try again.` };
  }

  if (response.ok || response.status === 429) return { ok: true };
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected", message: `${label} rejected that key. Check it and try again.` };
  }
  return { ok: false, reason: "unreachable", message: `${label} is having trouble right now. Try again shortly.` };
}
