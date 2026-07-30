import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@devcolab/database";

/**
 * AI-generated comments are attributed to a dedicated system account rather
 * than to whichever human happened to click "AI Review", so authorship in the
 * unified comment model stays truthful.
 */
const AI_USER_EMAIL = "ai-reviewer@devcolab.internal";

let cachedId: string | null = null;
let inflight: Promise<string> | null = null;

async function resolve(): Promise<string> {
  // Random unusable password — this account must never be able to log in.
  const unusablePassword = await bcrypt.hash(randomBytes(32).toString("hex"), 10);

  const user = await prisma.user.upsert({
    where: { email: AI_USER_EMAIL },
    update: {},
    create: {
      email: AI_USER_EMAIL,
      name: "DevColab AI",
      password: unusablePassword,
      role: "ai_reviewer",
    },
    select: { id: true },
  });

  cachedId = user.id;
  return user.id;
}

export async function getAiReviewerUserId(): Promise<string> {
  if (cachedId) return cachedId;
  // Collapse concurrent callers onto one upsert.
  inflight ??= resolve().finally(() => {
    inflight = null;
  });
  return inflight;
}
