import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, AuthRequest } from "../lib/middleware";

const router = Router();

const createSessionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  repositoryUrl: z.string().url().optional(),
});

/**
 * Only these fields are patchable. Passing req.body straight to Prisma would
 * let a client rewrite createdById and take over someone else's session.
 */
const updateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    repositoryUrl: z.string().url().nullable().optional(),
    status: z.enum(["active", "completed", "archived"]).optional(),
  })
  .strict();

const sessionInclude = {
  creator: { select: { id: true, name: true, email: true, role: true } },
  participants: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
  _count: { select: { comments: true } },
} as const;

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = createSessionSchema.parse(req.body);
    const session = await prisma.session.create({
      data: { ...data, createdById: req.user!.userId },
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

/**
 * Sessions the caller created or has joined.
 *
 * Deliberately not every session: the dashboard is a personal list. Sessions
 * remain reachable by anyone holding the (unguessable) id, which is how a
 * teammate joins one — see GET /:id.
 */
router.get("/", authenticate, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;

  const sessions = await prisma.session.findMany({
    where: {
      OR: [{ createdById: userId }, { participants: { some: { userId } } }],
    },
    include: sessionInclude,
    orderBy: { updatedAt: "desc" },
  });

  res.json(sessions);
});

/**
 * Open a session by id.
 *
 * Link-share semantics: anyone authenticated who has the id may open it, and
 * doing so enrols them as a participant so it appears on their dashboard from
 * then on. Ids are UUIDs, so they are not discoverable by guessing.
 */
router.get("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await prisma.session.findUnique({
    where: { id: req.params.id },
    include: {
      ...sessionInclude,
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

  await prisma.sessionParticipant.upsert({
    where: { sessionId_userId: { sessionId: session.id, userId: req.user!.userId } },
    update: {},
    create: { sessionId: session.id, userId: req.user!.userId },
  });

  res.json(session);
});

/** Only the creator may modify or delete a session. */
async function loadOwnedSession(req: AuthRequest, res: any) {
  const session = await prisma.session.findUnique({ where: { id: req.params.id } });

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  if (session.createdById !== req.user!.userId) {
    res.status(403).json({ error: "Only the session creator can do that" });
    return null;
  }
  return session;
}

router.patch("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;

  const parsed = updateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid update" });
    return;
  }

  const updated = await prisma.session.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(updated);
});

router.delete("/:id", authenticate, async (req: AuthRequest, res) => {
  const session = await loadOwnedSession(req, res);
  if (!session) return;

  await prisma.session.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
