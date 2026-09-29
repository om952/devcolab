import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, asyncHandler, AuthRequest } from "../lib/middleware";
import { ANY_MEMBER, requireSessionRole } from "../lib/session-access";

const router = Router({ mergeParams: true });

const createCommentSchema = z.object({
  content: z.string().min(1, "Comment cannot be empty"),
  category: z.enum(["bug", "security", "anti_pattern", "test", "general"]).default("general"),
  filePath: z.string().optional(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  parentId: z.string().uuid().optional(),
});

router.post(
  "/",
  authenticate,
  requireSessionRole("author", "reviewer"),
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid comment" });
      return;
    }
    const data = parsed.data;

    // A reply must stay in its thread's session; otherwise a comment here
    // could hang off a thread in a session the caller cannot see.
    if (data.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: data.parentId },
        select: { sessionId: true },
      });
      if (!parent || parent.sessionId !== req.params.sessionId) {
        res.status(404).json({ error: "Parent comment not found" });
        return;
      }
    }

    const comment = await prisma.comment.create({
      data: {
        ...data,
        sessionId: req.params.sessionId,
        authorId: req.user!.userId,
        authorType: "human",
      },
      include: { author: { select: { id: true, name: true, role: true } } },
    });
    res.status(201).json(comment);
  })
);

router.get(
  "/",
  authenticate,
  requireSessionRole(...ANY_MEMBER),
  asyncHandler(async (req: AuthRequest, res) => {
    const comments = await prisma.comment.findMany({
      where: { sessionId: req.params.sessionId },
      include: { author: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(comments);
  })
);

export default router;
