import type { Response, NextFunction } from "express";
import { prisma } from "@devcolab/database";
import { asyncHandler, type AuthRequest } from "./middleware";

/**
 * Only a session's creator may add files to it.
 *
 * This replaces `authorize("author")`, which was a global role and wrong in
 * both directions: any user holding the author role could upload into any
 * session whose id they had, while a creator who happened to hold the reviewer
 * role could not upload to their own session.
 *
 * Ownership is the axis that actually matters here, and it already governs
 * PATCH and DELETE on the session itself — this makes file writes consistent
 * with that rather than introducing a second, weaker rule.
 */
export const requireSessionCreator = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const session = await prisma.session.findUnique({
      where: { id: req.params.sessionId },
      select: { createdById: true },
    });

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.createdById !== req.user!.userId) {
      res.status(403).json({ error: "Only the session creator can add files" });
      return;
    }

    next();
  }
);
