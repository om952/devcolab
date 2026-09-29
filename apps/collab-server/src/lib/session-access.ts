import type { Response, NextFunction } from "express";
import { prisma } from "@devcolab/database";
import { asyncHandler, type AuthRequest } from "./middleware";

/**
 * What a user may do is decided per session, not by a global account role:
 *
 *   author       created the session: adds files, reviews, comments
 *   reviewer     joined the session (opened its link): reviews, comments
 *   ai_reviewer  the system account that writes AI comments
 *
 * The account-level `role` column only still matters for the AI system
 * account. Everyone registers as a reviewer; being the author of a session
 * comes from creating it, so the same person is the author of their own
 * sessions and a reviewer in everyone else's.
 */
export type SessionRole = "author" | "reviewer" | "ai_reviewer";

/** Every role that belongs to the session, for read-only routes. */
export const ANY_MEMBER: SessionRole[] = ["author", "reviewer", "ai_reviewer"];

/**
 * The caller's role in a session: `undefined` if the session does not exist,
 * `null` if it exists but the caller is not part of it.
 */
export async function getSessionRole(
  sessionId: string,
  userId: string
): Promise<SessionRole | null | undefined> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      createdById: true,
      participants: { where: { userId }, select: { id: true } },
    },
  });

  if (!session) return undefined;
  if (session.createdById === userId) return "author";

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role === "ai_reviewer") return "ai_reviewer";

  return session.participants.length > 0 ? "reviewer" : null;
}

/** The role shown next to someone in a session, from data the caller already has. */
export function roleInSession(
  userId: string,
  accountRole: string,
  createdById: string
): SessionRole {
  if (userId === createdById) return "author";
  return accountRole === "ai_reviewer" ? "ai_reviewer" : "reviewer";
}

const FORBIDDEN_MESSAGES: Partial<Record<SessionRole, string>> = {
  author: "Only the session creator can do that",
};

/**
 * Allow the request only if the caller holds one of `allowed` in the session
 * named by `:sessionId`. Sets `req.sessionRole` for the handler.
 *
 * A non-member gets 403, not 404: session ids are shared as links, so hiding
 * that one exists protects nothing, and "open the link first" is actionable.
 */
export function requireSessionRole(...allowed: SessionRole[]) {
  return asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = await getSessionRole(req.params.sessionId, req.user!.userId);

    if (role === undefined) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (role === null) {
      res.status(403).json({ error: "Open the session link to join it first" });
      return;
    }
    if (!allowed.includes(role)) {
      const onlyAuthor = allowed.length === 1 && allowed[0] === "author";
      res.status(403).json({
        error: (onlyAuthor && FORBIDDEN_MESSAGES.author) || "Your role in this session cannot do that",
      });
      return;
    }

    req.sessionRole = role;
    next();
  });
}
