import type { ErrorEvent } from "@sentry/node";

const SENSITIVE_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-llm-api-key", "x-internal-api-key"]);

/**
 * Strip credentials from an error report before it leaves the process.
 *
 * Sentry attaches the failing request, including its cookies and, by default,
 * its body. Here that would be a user's session cookie, or the LLM key they
 * just typed into /api/llm-key.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (!request) return event;

  delete request.cookies;

  if (request.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SENSITIVE_HEADERS.has(name.toLowerCase())) request.headers[name] = "[Filtered]";
    }
  }

  // Only the routes that carry secrets in the body lose it.
  const url = request.url ?? "";
  if (url.includes("/api/llm-key") || url.includes("/api/auth/")) {
    delete request.data;
  }

  return event;
}
