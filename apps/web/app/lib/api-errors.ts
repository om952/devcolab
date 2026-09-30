/**
 * What to tell a user when an API call did not succeed.
 *
 * On free hosting the API sleeps after 15 minutes idle and takes up to a minute
 * to wake; while it does, the proxy answers 502/503/504. That is not the user's
 * mistake and retrying shortly fixes it, so say so instead of failing silently.
 */
export const WAKING_MESSAGE =
  "The server is waking up (free hosting sleeps when idle). Give it about a minute, then try again.";

const WAKING_STATUSES = new Set([502, 503, 504]);

/** True when a status means "the server is not reachable right now". */
export function isServerUnavailable(status: number): boolean {
  return WAKING_STATUSES.has(status);
}

/**
 * A readable message for a failed response. Prefers the server's own message
 * when it sent JSON, and never surfaces a raw HTML error page.
 */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
  if (isServerUnavailable(res.status)) return WAKING_MESSAGE;
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

/** For a request that never got a response, such as a dropped connection. */
export function networkFailureMessage(): string {
  return "Could not reach the server. Check your connection and try again.";
}
