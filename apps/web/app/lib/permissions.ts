/**
 * Client-side mirror of the session-role guards in collab-server
 * (lib/session-access.ts, requireSessionRole).
 *
 * The server remains authoritative — every rule here is enforced again on the
 * API, and bypassing this file only earns a 403. Its job is to stop the UI
 * offering controls that are guaranteed to fail, and to explain why a control
 * is unavailable instead of surfacing a generic error after the fact.
 *
 * Roles are per session: whoever created a session is its author, everyone
 * who joined through its link is a reviewer. Keep in sync with:
 *   routes/files.ts      POST: author
 *   routes/ai-review.ts  POST: author, reviewer
 *   routes/comments.ts   POST: author, reviewer
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

/** Your role in one session: author if you created it, otherwise reviewer. */
export function sessionRole(userId?: string | null, createdById?: string | null): Role | null {
  if (!userId || !createdById) return null;
  return userId === createdById ? "author" : "reviewer";
}

/** Authors and reviewers may request an AI review. */
export function canTriggerReview(role?: string | null): boolean {
  return role === "author" || role === "reviewer";
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
