import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, authorize, AuthRequest } from "../lib/middleware";
import { aiReviewLimiter } from "../lib/rate-limit";
import { enqueueReview, enqueueReviewBatch } from "../services/ai-review-runner";
import logger from "../lib/logger";

/**
 * Ceiling on a single folder review. Every file costs four LLM calls, so an
 * unbounded batch would exhaust a provider's quota in one click.
 */
const MAX_BATCH_REVIEW_FILES = 25;

// Mounted at /api/sessions/:sessionId/ai-review — paths here are relative to
// that prefix, so they must not repeat it.
const router = Router({ mergeParams: true });

const triggerSchema = z.object({
  fileId: z.string().uuid(),
});

const batchTriggerSchema = z.object({
  // Omitted means "every file in the session".
  fileIds: z.array(z.string().uuid()).min(1).optional(),
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

/**
 * Trigger a review across many files — the folder-review path.
 *
 * Deliberately one request rather than a client-side loop: the per-user rate
 * limit is 5/min, so looping would stall after five files, and batching keeps
 * scheduling and the file-count ceiling on the server where they are enforced.
 *
 * Omit `fileIds` to review every file in the session.
 */
router.post(
  "/batch",
  authenticate,
  aiReviewLimiter,
  authorize("author", "reviewer", "ai_reviewer"),
  async (req: AuthRequest, res) => {
    const parsed = batchTriggerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    const sessionId = req.params.sessionId;

    const sessionFiles = await prisma.codeFile.findMany({
      where: { sessionId },
      select: { id: true, filePath: true },
      orderBy: { filePath: "asc" },
    });

    if (sessionFiles.length === 0) {
      res.status(400).json({ error: "This session has no files to review" });
      return;
    }

    const known = new Map(sessionFiles.map((f) => [f.id, f.filePath]));
    const requested = parsed.data.fileIds ?? sessionFiles.map((f) => f.id);

    // Ignore ids belonging to another session rather than reviewing them.
    const valid = requested.filter((id) => known.has(id));
    if (valid.length === 0) {
      res.status(404).json({ error: "None of those files belong to this session" });
      return;
    }

    const selected = valid.slice(0, MAX_BATCH_REVIEW_FILES);
    const overflow = valid.slice(MAX_BATCH_REVIEW_FILES);

    try {
      const result = await enqueueReviewBatch({
        sessionId,
        fileIds: selected,
        userId: req.user!.userId,
        io: req.app.get("io") ?? null,
      });

      res.status(202).json({
        runs: result.runs.map((run) => ({ ...run, filePath: known.get(run.fileId) })),
        queued: result.queued,
        attached: result.attached,
        skipped: overflow.map((id) => ({ fileId: id, filePath: known.get(id), reason: "over the per-batch limit" })),
        limit: MAX_BATCH_REVIEW_FILES,
        message: `Queued ${result.queued} file(s) for review — progress streams over the session socket`,
      });
    } catch (err) {
      logger.error({ err, sessionId }, "Failed to enqueue batch AI review");
      res.status(500).json({ error: "Could not start batch review" });
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
