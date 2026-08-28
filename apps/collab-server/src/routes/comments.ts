import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, asyncHandler, AuthRequest } from "../lib/middleware";

const router = Router({ mergeParams: true });

const createCommentSchema = z.object({
  content: z.string().min(1),
  category: z.enum(["bug", "security", "anti_pattern", "test", "general"]).default("general"),
  filePath: z.string().optional(),
  lineStart: z.number().int().optional(),
  lineEnd: z.number().int().optional(),
  parentId: z.string().optional(),
});

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = createCommentSchema.parse(req.body);
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
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get(
  "/",
  authenticate,
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
