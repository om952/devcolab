import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, AuthRequest } from "../lib/middleware";

const router = Router();

const createSessionSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  repositoryUrl: z.string().url().optional(),
});

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = createSessionSchema.parse(req.body);
    const session = await prisma.session.create({
      data: {
        ...data,
        createdById: req.user!.userId,
      },
      include: { creator: { select: { id: true, name: true, email: true, role: true } } },
    });
    await prisma.sessionParticipant.create({
      data: { sessionId: session.id, userId: req.user!.userId },
    });
    res.status(201).json(session);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/", authenticate, async (_req: AuthRequest, res) => {
  const sessions = await prisma.session.findMany({
    include: {
      creator: { select: { id: true, name: true, email: true, role: true } },
      participants: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
      _count: { select: { comments: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(sessions);
});

router.get("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await prisma.session.findUnique({
    where: { id: req.params.id },
    include: {
      creator: { select: { id: true, name: true, email: true, role: true } },
      participants: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
      codeFiles: true,
      comments: {
        include: { author: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

router.patch("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.createdById !== req.user!.userId && req.user!.role !== "author") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const updated = await prisma.session.update({
    where: { id: req.params.id },
    data: req.body,
  });
  res.json(updated);
});

router.delete("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.createdById !== req.user!.userId && req.user!.role !== "author") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await prisma.session.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
