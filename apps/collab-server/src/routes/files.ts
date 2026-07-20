import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, AuthRequest } from "../lib/middleware";

const router = Router({ mergeParams: true });

const createFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  language: z.string().optional(),
});

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = createFileSchema.parse(req.body);
    const file = await prisma.codeFile.create({
      data: {
        ...data,
        sessionId: req.params.sessionId,
      },
    });
    res.status(201).json(file);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/", authenticate, async (req: AuthRequest, res) => {
  const files = await prisma.codeFile.findMany({
    where: { sessionId: req.params.sessionId },
    orderBy: { filePath: "asc" },
  });
  res.json(files);
});

router.get("/:fileId", authenticate, async (req: AuthRequest, res) => {
  const file = await prisma.codeFile.findUnique({
    where: { id: req.params.fileId },
  });
  if (!file || file.sessionId !== req.params.sessionId) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.json(file);
});

export default router;
