import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, authorize, AuthRequest } from "../lib/middleware";
import { aiReviewLimiter } from "../lib/rate-limit";
import { enqueueReview } from "../services/ai-review-runner";
import logger from "../lib/logger";

// Mounted at /api/sessions/:sessionId/ai-review — paths here are relative to
// that prefix, so they must not repeat it.
const router = Router({ mergeParams: true });

const triggerSchema = z.object({
  fileId: z.string().uuid(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

/** Trigger a review. Returns 202 immediately; progress arrives over Socket.IO. */
router.post(
  "/",
  authenticate,
  aiReviewLimiter,
  authorize("author", "reviewer", "ai_reviewer"),
  async (req: AuthRequest, res) => {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "fileId must be a valid uuid" });
      return;
    }

    const sessionId = req.params.sessionId;
    const { fileId } = parsed.data;

    const file = await prisma.codeFile.findUnique({
      where: { id: fileId },
      select: { id: true, sessionId: true },
    });
    if (!file || file.sessionId !== sessionId) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    try {
      const { run, alreadyRunning } = await enqueueReview({
        sessionId,
        fileId,
        userId: req.user!.userId,
        io: req.app.get("io") ?? null,
      });

      res.status(202).json({
        runId: run.id,
        status: run.status,
        alreadyRunning,
        message: alreadyRunning
          ? "A review is already in progress for this file"
          : "Review queued — results stream over the session socket",
      });
    } catch (err) {
      logger.error({ err, sessionId, fileId }, "Failed to enqueue AI review");
      res.status(500).json({ error: "Could not start review" });
    }
  }
);

/** List past runs for a session, newest first. */
router.get("/", authenticate, async (req: AuthRequest, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pagination parameters" });
    return;
  }

  const { limit, cursor } = parsed.data;

  const runs = await prisma.aIReviewRun.findMany({
    where: { sessionId: req.params.sessionId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      agentRuns: {
        select: { agentType: true, status: true, issueCount: true, error: true, durationMs: true },
      },
    },
  });

  const hasMore = runs.length > limit;
  const page = hasMore ? runs.slice(0, limit) : runs;

  res.json({
    runs: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
});

/** Poll a single run — the fallback for clients that miss socket events. */
router.get("/:runId", authenticate, async (req: AuthRequest, res) => {
  if (!z.string().uuid().safeParse(req.params.runId).success) {
    res.status(400).json({ error: "Invalid runId" });
    return;
  }

  const run = await prisma.aIReviewRun.findUnique({
    where: { id: req.params.runId },
    include: {
      agentRuns: {
        select: {
          agentType: true,
          status: true,
          issueCount: true,
          error: true,
          durationMs: true,
          completedAt: true,
        },
      },
    },
  });

  if (!run || run.sessionId !== req.params.sessionId) {
    res.status(404).json({ error: "Review run not found" });
    return;
  }

  res.json(run);
});

export default router;
