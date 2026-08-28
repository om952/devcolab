/**
 * Client-side mirror of the `authorize(...)` guards in collab-server.
 *
 * The server remains authoritative — every rule here is enforced again on the
 * API, and bypassing this file only earns a 403. Its job is to stop the UI
 * offering controls that are guaranteed to fail, and to explain why a control
 * is unavailable instead of surfacing a generic error after the fact.
 *
 * Keep in sync with:
 *   routes/files.ts      requireSessionCreator (ownership, not role)
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

/**
 * Adding files is an ownership question, not a role one: you may add files to
 * a session you created. A global role was wrong in both directions — it let
 * any author write into anyone's session, and stopped a creator holding the
 * reviewer role from writing into their own.
 */
export function canAddFiles(userId?: string | null, createdById?: string | null): boolean {
  return Boolean(userId && createdById && userId === createdById);
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
export function whyCannotAddFiles(
  userId?: string | null,
  createdById?: string | null
): string | null {
  return canAddFiles(userId, createdById)
    ? null
    : "Only the person who created this session can add files to it.";
}
