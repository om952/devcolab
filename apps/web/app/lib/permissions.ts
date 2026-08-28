/**
 * Client-side mirror of the `authorize(...)` guards in collab-server.
 *
 * The server remains authoritative — every rule here is enforced again on the
 * API, and bypassing this file only earns a 403. Its job is to stop the UI
 * offering controls that are guaranteed to fail, and to explain why a control
 * is unavailable instead of surfacing a generic error after the fact.
 *
 * Keep in sync with:
 *   routes/files.ts      authorize("author")
 *   routes/ai-review.ts  authorize("author", "reviewer", "ai_reviewer")
 *   routes/sessions.ts   creator-only for PATCH / DELETE
 */

export type Role = "author" | "reviewer" | "ai_reviewer";

export const ROLE_LABELS: Record<string, string> = {
  author: "Author",
  reviewer: "Reviewer",
  ai_reviewer: "AI Reviewer",
};

export function roleLabel(role?: string | null): string {
  return role ? ROLE_LABELS[role] ?? role : "Unknown";
}

/** Only authors own the code under review, so only they may add files. */
export function canAddFiles(role?: string | null): boolean {
  return role === "author";
}

/** Any authenticated participant may request an AI review. */
export function canTriggerReview(role?: string | null): boolean {
  return role === "author" || role === "reviewer" || role === "ai_reviewer";
}

/** Session settings are ownership-based, not role-based. */
export function canManageSession(userId?: string | null, createdById?: string | null): boolean {
  return Boolean(userId && createdById && userId === createdById);
}

/** Human-readable reason a control is disabled, or null when it is allowed. */
export function whyCannotAddFiles(role?: string | null): string | null {
  return canAddFiles(role)
    ? null
    : `Only the author can add files to a session. You joined as ${roleLabel(role)}.`;
}
