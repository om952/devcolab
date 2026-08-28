import { Router } from "express";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import { authenticate, authorize, AuthRequest } from "../lib/middleware";
import { env } from "../lib/env";
import logger from "../lib/logger";

const router = Router({ mergeParams: true });

/** Upper bound on files accepted per batch request. The client chunks to stay
 * under this and under the JSON body limit. */
const MAX_FILES_PER_BATCH = 200;

/**
 * Normalise a client-supplied relative path.
 *
 * Paths come from the browser's `webkitRelativePath`, so they are untrusted:
 * reject traversal and absolute paths rather than storing a path that renders
 * as something it is not.
 */
function normalizeFilePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return null;

  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "..")) return null;

  const joined = segments.join("/");
  return joined.length <= 1024 ? joined : null;
}

const createFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  language: z.string().optional(),
});

const batchFileSchema = z.object({
  files: z
    .array(createFileSchema)
    .min(1, "At least one file is required")
    .max(MAX_FILES_PER_BATCH, `At most ${MAX_FILES_PER_BATCH} files per request`),
});

/**
 * Create or replace one file. Upserts rather than creates so re-uploading a
 * path updates it instead of tripping the (sessionId, filePath) unique index.
 */
async function upsertFile(params: {
  sessionId: string;
  filePath: string;
  content: string;
  language?: string;
}) {
  const { sessionId, filePath, content, language } = params;
  return prisma.codeFile.upsert({
    where: { sessionId_filePath: { sessionId, filePath } },
    update: { content, language },
    create: { sessionId, filePath, content, language },
  });
}

router.post("/", authenticate, authorize("author"), async (req: AuthRequest, res) => {
  try {
    const data = createFileSchema.parse(req.body);

    const filePath = normalizeFilePath(data.filePath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }
    if (Buffer.byteLength(data.content, "utf8") > env.MAX_CODE_FILE_BYTES) {
      res.status(413).json({
        error: `File exceeds the ${Math.floor(env.MAX_CODE_FILE_BYTES / 1024)} KB limit`,
      });
      return;
    }

    const file = await upsertFile({
      sessionId: req.params.sessionId,
      filePath,
      content: data.content,
      language: data.language,
    });
    res.status(201).json(file);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Bulk upload — the folder-import path.
 *
 * Oversized or malformed entries are skipped and reported individually rather
 * than failing the whole batch, so one bad file in a large folder does not
 * discard the rest of the import.
 */
router.post("/batch", authenticate, authorize("author"), async (req: AuthRequest, res) => {
  const parsed = batchFileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid batch" });
    return;
  }

  const sessionId = req.params.sessionId;
  const created: unknown[] = [];
  const skipped: { filePath: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const entry of parsed.data.files) {
    const filePath = normalizeFilePath(entry.filePath);
    if (!filePath) {
      skipped.push({ filePath: entry.filePath, reason: "invalid path" });
      continue;
    }
    if (seen.has(filePath)) {
      skipped.push({ filePath, reason: "duplicate path in request" });
      continue;
    }
    if (Buffer.byteLength(entry.content, "utf8") > env.MAX_CODE_FILE_BYTES) {
      skipped.push({ filePath, reason: "too large" });
      continue;
    }
    seen.add(filePath);

    try {
      created.push(
        await upsertFile({
          sessionId,
          filePath,
          content: entry.content,
          language: entry.language,
        })
      );
    } catch (err) {
      logger.warn({ err, sessionId, filePath }, "Batch file upload failed for one entry");
      skipped.push({ filePath, reason: "write failed" });
    }
  }

  res.status(201).json({ files: created, skipped, createdCount: created.length });
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
