import { Router } from "express";
import { z } from "zod";
import { authenticate, asyncHandler, type AuthRequest } from "../lib/middleware";
import { llmKeyLimiter } from "../lib/rate-limit";
import {
  LLM_PROVIDERS,
  clearCredential,
  credentialStatus,
  setCredential,
} from "../lib/llm-credentials";
import { checkKeyWithProvider } from "../lib/llm-key-check";

const router = Router();

const keySchema = z.object({
  provider: z.enum(LLM_PROVIDERS as [string, ...string[]], {
    errorMap: () => ({ message: "Choose Gemini or Groq" }),
  }),
  // Provider keys are a few dozen characters; a hard cap stops anything absurd
  // from being held in memory.
  apiKey: z.string().trim().min(8, "That does not look like an API key").max(256),
});

/** What is set, never the key itself. */
router.get("/", authenticate, (req: AuthRequest, res) => {
  const status = credentialStatus(req.user!.userId);
  res.json(status ? { configured: true, ...status } : { configured: false });
});

router.put(
  "/",
  authenticate,
  llmKeyLimiter,
  asyncHandler(async (req: AuthRequest, res) => {
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const { provider, apiKey } = parsed.data as { provider: "gemini" | "groq"; apiKey: string };

    const check = await checkKeyWithProvider(provider, apiKey);
    if (!check.ok) {
      res.status(check.reason === "rejected" ? 400 : 502).json({ error: check.message });
      return;
    }

    const { expiresAt } = setCredential(req.user!.userId, { provider, apiKey });
    res.json({ configured: true, provider, expiresAt });
  })
);

router.delete("/", authenticate, (req: AuthRequest, res) => {
  clearCredential(req.user!.userId);
  res.status(204).send();
});

export default router;
