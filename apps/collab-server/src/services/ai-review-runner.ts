import type { Server } from "socket.io";
import { prisma } from "@devcolab/database";
import { env } from "../lib/env";
import logger from "../lib/logger";
import { getAiReviewerUserId } from "../lib/ai-user";
import { enqueueReviewJob } from "../lib/queue";
import { getCredential, redactKey, type LlmCredential } from "../lib/llm-credentials";
import {
  generateHeuristicReview,
  type IssueCategory,
  type IssueSeverity,
  type ReviewIssue,
} from "./heuristic-review";

type AgentType = "bug_detection" | "security_scan" | "anti_pattern" | "test_generation";

/** ai-service reports findings by category; the schema records them by agent. */
const AGENT_BY_CATEGORY: Record<string, AgentType> = {
  bug: "bug_detection",
  security: "security_scan",
  anti_pattern: "anti_pattern",
  test: "test_generation",
};

const ALL_AGENTS: AgentType[] = ["bug_detection", "security_scan", "anti_pattern", "test_generation"];

const VALID_CATEGORIES: IssueCategory[] = ["bug", "security", "anti_pattern", "test", "general"];
const VALID_SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low", "info"];

export type ReviewEngine = "ai" | "heuristic-fallback";

interface SseEvent {
  type: string;
  agent?: string;
  category?: string;
  issues?: any[];
  summary?: string;
  message?: string;
  code?: string;
  /** Set on `agent_complete` when that specific agent failed or timed out. */
  error?: string | null;
  agent_errors?: { agent: string; error: string }[];
}

/** Parse an SSE body into discrete JSON events. Exported for tests. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        try {
          yield JSON.parse(dataLine.slice(5).trim()) as SseEvent;
        } catch {
          logger.warn({ chunk }, "Skipping unparsable SSE frame");
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function coerceIssue(raw: any, fallbackCategory: IssueCategory): ReviewIssue | null {
  const message = String(raw?.message ?? "").trim();
  if (!message) return null;

  const category = VALID_CATEGORIES.includes(raw?.category) ? raw.category : fallbackCategory;
  const severity = VALID_SEVERITIES.includes(raw?.severity) ? raw.severity : "info";

  const toLine = (value: any): number | null => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    category,
    severity,
    message,
    suggestion: String(raw?.suggestion ?? "").trim() || "No specific suggestion provided.",
    line_start: toLine(raw?.line_start),
    line_end: toLine(raw?.line_end),
  };
}

/** Persist one agent's findings as comments and mark its AIReview row done. */
async function persistAgentResult(params: {
  runId: string;
  sessionId: string;
  fileId: string;
  filePath: string;
  agentType: AgentType;
  issues: ReviewIssue[];
  aiUserId: string;
  durationMs: number;
  io: Server | null;
  error?: string;
}) {
  const { runId, sessionId, fileId, filePath, agentType, issues, aiUserId, durationMs, io, error } = params;

  const comments = await prisma.$transaction(async (tx) => {
    await tx.aIReview.updateMany({
      where: { runId, agentType },
      data: {
        status: error ? "failed" : "completed",
        result: JSON.stringify(issues),
        issueCount: issues.length,
        error: error ?? null,
        durationMs,
        completedAt: new Date(),
      },
    });

    const created = [];
    for (const issue of issues) {
      created.push(
        await tx.comment.create({
          data: {
            sessionId,
            codeFileId: fileId,
            authorId: aiUserId,
            authorType: "ai",
            category: issue.category,
            content: `${issue.message}\n\n**Suggestion:** ${issue.suggestion}`,
            filePath,
            lineStart: issue.line_start,
            lineEnd: issue.line_end,
          },
          include: { author: { select: { id: true, name: true, role: true } } },
        })
      );
    }
    return created;
  });

  if (io) {
    for (const comment of comments) {
      io.to(sessionId).emit("comment:created", comment);
    }
    io.to(sessionId).emit("ai:agent_completed", {
      runId,
      agent: agentType,
      issueCount: issues.length,
      error: error ?? null,
    });
  }

  return comments;
}

/**
 * Consume the ai-service SSE stream, persisting and broadcasting each agent's
 * findings the moment they land rather than waiting for the whole run.
 */
async function runViaAiService(params: {
  runId: string;
  sessionId: string;
  fileId: string;
  filePath: string;
  code: string;
  language: string;
  aiUserId: string;
  io: Server | null;
  credential: LlmCredential;
}): Promise<{ totalIssues: number; summary: string; degraded: boolean }> {
  const { runId, sessionId, fileId, filePath, code, language, aiUserId, io, credential } = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The run id doubles as the correlation id, so ai-service logs for this
    // review can be joined to the collab-server run record.
    "X-Request-Id": runId,
  };
  if (env.INTERNAL_API_KEY) headers["X-Internal-Api-Key"] = env.INTERNAL_API_KEY;
  // The user's own key, for this one call. Headers, not the body, since bodies
  // are what loggers and error reporters capture.
  headers["X-LLM-Provider"] = credential.provider;
  headers["X-LLM-Api-Key"] = credential.apiKey;

  const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/review/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, language, file_path: filePath, session_id: sessionId }),
    signal: AbortSignal.timeout(env.AI_REVIEW_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(`AI service returned ${response.status}`);
  }


  const seenAgents = new Set<AgentType>();
  let totalIssues = 0;
  let summary = "";
  let degraded = false;
  let lastAt = Date.now();

  for await (const event of parseSseStream(response.body)) {
    if (event.type === "error") {
      throw new Error(event.message || "AI service reported an error");
    }

    if (event.type === "agent_complete") {
      const agentType = AGENT_BY_CATEGORY[event.category ?? ""] ?? null;
      if (!agentType) continue;

      const fallbackCategory = (event.category ?? "general") as IssueCategory;
      const issues = (event.issues ?? [])
        .map((raw) => coerceIssue(raw, fallbackCategory))
        .filter((issue): issue is ReviewIssue => issue !== null);

      const now = Date.now();
      // An agent that failed inside ai-service must be recorded as failed, not
      // as "completed with no findings" — those look identical to a reviewer
      // otherwise, and silently understate what was actually checked.
      const agentError = event.error ?? undefined;
      if (agentError) degraded = true;

      await persistAgentResult({
        runId,
        sessionId,
        fileId,
        filePath,
        agentType,
        issues,
        aiUserId,
        durationMs: now - lastAt,
        io,
        error: agentError,
      });
      lastAt = now;

      seenAgents.add(agentType);
      totalIssues += issues.length;
    }

    if (event.type === "consolidated") {
      summary = event.summary ?? "";
      // OR rather than assign: a failure already seen on a per-agent event must
      // not be cleared by a consolidated payload that omits it.
      degraded = degraded || (event.agent_errors?.length ?? 0) > 0;
    }
  }

  // Any agent the stream never reported on did not run.
  const missing = ALL_AGENTS.filter((agent) => !seenAgents.has(agent));
  if (missing.length > 0) {
    degraded = true;
    await prisma.aIReview.updateMany({
      where: { runId, agentType: { in: missing } },
      data: { status: "failed", error: "agent did not report", completedAt: new Date() },
    });
  }

  return { totalIssues, summary: summary || `Found ${totalIssues} issues.`, degraded };
}

/** Fallback path: regex scan, clearly labelled as not-AI. */
async function runViaHeuristics(params: {
  runId: string;
  sessionId: string;
  fileId: string;
  filePath: string;
  code: string;
  language: string;
  aiUserId: string;
  io: Server | null;
}): Promise<{ totalIssues: number; summary: string }> {
  const { runId, sessionId, fileId, filePath, code, language, aiUserId, io } = params;
  const result = generateHeuristicReview(code, language);

  for (const agentType of ALL_AGENTS) {
    const category = Object.keys(AGENT_BY_CATEGORY).find(
      (key) => AGENT_BY_CATEGORY[key] === agentType
    ) as IssueCategory;
    const issues = result.issues.filter((issue) => issue.category === category);

    await persistAgentResult({
      runId,
      sessionId,
      fileId,
      filePath,
      agentType,
      issues,
      aiUserId,
      durationMs: 0,
      io,
    });
  }

  return { totalIssues: result.issues.length, summary: result.summary };
}

/** An error safe to log: the user's key removed from its message and stack. */
function redactErr(err: unknown, apiKey: string): unknown {
  if (!(err instanceof Error)) return err;
  const safe = new Error(redactKey(err.message, apiKey));
  safe.name = err.name;
  safe.stack = redactKey(err.stack ?? "", apiKey);
  return safe;
}

/**
 * The run was queued but its owner's key is gone (logout, expiry, or a restart
 * that emptied memory). Fail it plainly rather than quietly running the regex
 * scanner and presenting that as the AI review they asked for.
 */
async function failRunForMissingKey(params: {
  runId: string;
  sessionId: string;
  fileId: string;
  io: Server | null;
}) {
  const { runId, sessionId, fileId, io } = params;
  const message = "Your AI key is no longer available. Add it again and re-run the review.";

  await prisma.$transaction([
    prisma.aIReview.updateMany({
      where: { runId },
      data: { status: "failed", error: message, completedAt: new Date() },
    }),
    prisma.aIReviewRun.update({
      where: { id: runId },
      data: { status: "failed", error: message, completedAt: new Date() },
    }),
  ]);

  io?.to(sessionId).emit("ai:review_failed", { runId, fileId, error: message, code: "llm_key_required" });
}

export async function processRun(runId: string, io: Server | null): Promise<void> {
  const run = await prisma.aIReviewRun.findUnique({
    where: { id: runId },
    include: { codeFile: true },
  });

  if (!run || !run.codeFile) {
    logger.warn({ runId }, "Review run vanished or has no file");
    return;
  }

  const { sessionId, codeFile } = run;
  const log = logger.child({ runId, sessionId, fileId: codeFile.id });

  await prisma.aIReviewRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });
  io?.to(sessionId).emit("ai:review_started", { runId, fileId: codeFile.id, agents: ALL_AGENTS });

  const shared = {
    runId,
    sessionId,
    fileId: codeFile.id,
    filePath: codeFile.filePath,
    code: codeFile.content,
    language: codeFile.language || "typescript",
    io,
  };

  try {
    const aiUserId = await getAiReviewerUserId();

    // Looked up now, not when the run was queued: a run that waits its turn, or
    // is retried after a restart, must not use a key the user has since removed.
    const credential = getCredential(run.triggeredById);
    if (!credential) {
      await failRunForMissingKey({ runId, sessionId, fileId: codeFile.id, io });
      return;
    }

    let engine: ReviewEngine = "ai";
    let outcome: { totalIssues: number; summary: string; degraded?: boolean };

    try {
      outcome = await runViaAiService({ ...shared, aiUserId, credential });
    } catch (aiErr) {
      log.warn(
        { err: redactErr(aiErr, credential.apiKey) },
        "AI service unavailable, falling back to heuristic scanner"
      );
      engine = "heuristic-fallback";
      outcome = await runViaHeuristics({ ...shared, aiUserId });
    }

    const degraded = engine === "heuristic-fallback" || Boolean(outcome.degraded);

    await prisma.aIReviewRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        engine,
        summary: outcome.summary,
        totalIssues: outcome.totalIssues,
        degraded,
        completedAt: new Date(),
      },
    });

    io?.to(sessionId).emit("ai:review_completed", {
      runId,
      fileId: codeFile.id,
      summary: outcome.summary,
      totalIssues: outcome.totalIssues,
      engine,
      degraded,
    });

    log.info({ engine, totalIssues: outcome.totalIssues, degraded }, "Review run completed");
  } catch (err: any) {
    log.error({ err }, "Review run failed");

    await prisma.aIReviewRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          error: String(err?.message ?? err).slice(0, 1000),
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    io?.to(sessionId).emit("ai:review_failed", { runId, error: "Review failed" });
  }
}

/**
 * Bounded scheduler for the no-Redis path.
 *
 * BullMQ caps concurrency at AI_REVIEW_CONCURRENCY, but the in-process
 * fallback used to hand every run straight to setImmediate. Reviewing a folder
 * that way would start one run per file at once — four LLM calls each — and
 * trip provider rate limits immediately. Queue locally instead, draining at the
 * same concurrency the worker uses.
 */
const pendingInProcess: Array<{ runId: string; io: Server | null }> = [];
let activeInProcess = 0;

function pumpInProcess(): void {
  while (activeInProcess < env.AI_REVIEW_CONCURRENCY && pendingInProcess.length > 0) {
    const next = pendingInProcess.shift()!;
    activeInProcess += 1;

    processRun(next.runId, next.io)
      .catch((err) => logger.error({ err, runId: next.runId }, "Unhandled review run error"))
      .finally(() => {
        activeInProcess -= 1;
        pumpInProcess();
      });
  }
}

function scheduleInProcess(runId: string, io: Server | null): void {
  pendingInProcess.push({ runId, io });
  setImmediate(pumpInProcess);
}

/** Exposed for tests and logging: how much in-process work is outstanding. */
export function inProcessBacklog(): { active: number; queued: number } {
  return { active: activeInProcess, queued: pendingInProcess.length };
}

export interface EnqueueResult {
  run: { id: string; status: string };
  alreadyRunning: boolean;
}

/**
 * Create a review run and start it in the background. Returns immediately so
 * the HTTP request does not block on the LLM.
 */
export async function enqueueReview(params: {
  sessionId: string;
  fileId: string;
  userId: string;
  io: Server | null;
}): Promise<EnqueueResult> {
  const { sessionId, fileId, userId, io } = params;

  // One active run per file — a second click should attach to the first.
  const existing = await prisma.aIReviewRun.findFirst({
    where: { sessionId, codeFileId: fileId, status: { in: ["pending", "running"] } },
    select: { id: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { run: existing, alreadyRunning: true };
  }

  const run = await prisma.aIReviewRun.create({
    data: {
      sessionId,
      codeFileId: fileId,
      triggeredById: userId,
      status: "pending",
      agentRuns: {
        create: ALL_AGENTS.map((agentType) => ({
          sessionId,
          agentType,
          status: "pending" as const,
        })),
      },
    },
    select: { id: true, status: true },
  });

  // Prefer the durable queue so the run survives a restart. Fall back to
  // running in-process when Redis is not configured (local development).
  let queued = false;
  try {
    queued = await enqueueReviewJob(run.id);
  } catch (err) {
    logger.error({ err, runId: run.id }, "Could not enqueue review job, running in-process");
  }

  if (!queued) {
    scheduleInProcess(run.id, io);
  }

  return { run, alreadyRunning: false };
}

export interface BatchEnqueueResult {
  runs: Array<{ runId: string; fileId: string; status: string; alreadyRunning: boolean }>;
  queued: number;
  attached: number;
}

/**
 * Queue a review for several files at once — the folder-review path.
 *
 * Each file keeps its own AIReviewRun rather than introducing a parent job:
 * per-file runs stay independently observable, retryable and dedupable, and
 * reuse the queue, reconciliation sweep and per-agent rows unchanged.
 */
export async function enqueueReviewBatch(params: {
  sessionId: string;
  fileIds: string[];
  userId: string;
  io: Server | null;
}): Promise<BatchEnqueueResult> {
  const { sessionId, fileIds, userId, io } = params;
  const runs: BatchEnqueueResult["runs"] = [];

  for (const fileId of fileIds) {
    const { run, alreadyRunning } = await enqueueReview({ sessionId, fileId, userId, io });
    runs.push({ runId: run.id, fileId, status: run.status, alreadyRunning });
  }

  return {
    runs,
    queued: runs.filter((r) => !r.alreadyRunning).length,
    attached: runs.filter((r) => r.alreadyRunning).length,
  };
}

/**
 * Fail runs left behind by a crash or restart, so nothing sits in `running`
 * forever. Only touches runs older than twice the review timeout, which makes
 * it safe to run alongside other live instances.
 */
export async function reconcileStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - env.AI_REVIEW_TIMEOUT_MS * 2);

  const { count } = await prisma.aIReviewRun.updateMany({
    where: { status: { in: ["pending", "running"] }, createdAt: { lt: cutoff } },
    data: { status: "failed", error: "Abandoned — server restarted or run timed out", completedAt: new Date() },
  });

  if (count > 0) logger.warn({ count }, "Marked stale AI review runs as failed");
  return count;
}
