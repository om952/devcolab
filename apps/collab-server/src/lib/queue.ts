import { Queue, Worker, type Job } from "bullmq";
import { redis } from "./redis";
import { env } from "./env";
import logger from "./logger";

/**
 * Durable job queue for AI reviews.
 *
 * Without this, a review lives only in the process that started it, so a
 * restart mid-run abandons the work. BullMQ persists jobs in Redis: a
 * restarted worker picks them back up, and a worker that dies mid-job has it
 * re-delivered once the job is declared stalled.
 *
 * Deliberately optional — with no REDIS_URL the caller falls back to running
 * in-process, which keeps local development working without Redis.
 */

export const REVIEW_QUEUE_NAME = "ai-review";

export type ReviewJobData = { runId: string };

let queue: Queue<ReviewJobData> | null = null;

export function queueEnabled(): boolean {
  return redis !== null;
}

function getQueue(): Queue<ReviewJobData> | null {
  if (!redis) return null;
  // BullMQ needs a dedicated connection; sharing ours would let blocking
  // commands stall unrelated traffic.
  queue ??= new Queue<ReviewJobData>(REVIEW_QUEUE_NAME, { connection: redis.duplicate() });
  return queue;
}

/**
 * Hand a run to the queue. Returns false when queueing is unavailable, so the
 * caller can decide to run it in-process instead.
 */
export async function enqueueReviewJob(runId: string): Promise<boolean> {
  const q = getQueue();
  if (!q) return false;

  await q.add(
    "review",
    { runId },
    {
      jobId: runId, // Idempotent: re-adding the same run is a no-op.
      attempts: env.AI_REVIEW_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    }
  );
  return true;
}

let worker: Worker<ReviewJobData> | null = null;

/**
 * Start consuming review jobs. The handler is injected so this module never
 * imports the runner — that would create an import cycle.
 */
export function startReviewWorker(handler: (runId: string) => Promise<void>): Worker<ReviewJobData> | null {
  if (!redis) {
    logger.warn("REDIS_URL unset — AI reviews run in-process and will not survive a restart");
    return null;
  }

  worker = new Worker<ReviewJobData>(
    REVIEW_QUEUE_NAME,
    async (job: Job<ReviewJobData>) => handler(job.data.runId),
    {
      connection: redis.duplicate(),
      concurrency: env.AI_REVIEW_CONCURRENCY,
      // A job whose worker died is re-delivered after this long.
      stalledInterval: 30_000,
      maxStalledCount: 2,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { err, runId: job?.data.runId, attempt: job?.attemptsMade },
      "AI review job failed"
    );
  });
  worker.on("stalled", (jobId) => {
    logger.warn({ jobId }, "AI review job stalled, will be retried");
  });
  worker.on("error", (err) => {
    logger.error({ err }, "Review worker error");
  });

  logger.info({ concurrency: env.AI_REVIEW_CONCURRENCY }, "AI review worker started");
  return worker;
}

/** Stop consuming and release Redis connections. */
export async function closeQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
