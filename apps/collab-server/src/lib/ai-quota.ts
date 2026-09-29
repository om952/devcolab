import { prisma } from "@devcolab/database";
import { env } from "./env";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many more reviews this user may start, counted from the runs recorded in
 * the last 24 hours.
 *
 * Counted in Postgres rather than in memory or Redis: on a host that sleeps and
 * restarts, an in-process counter resets and hands everyone a fresh allowance,
 * while the run rows survive.
 */
export async function remainingDailyReviews(userId: string): Promise<number> {
  const used = await prisma.aIReviewRun.count({
    where: { triggeredById: userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  return Math.max(0, env.AI_REVIEW_DAILY_LIMIT - used);
}

export function dailyLimitMessage(): string {
  return `Daily AI review limit reached (${env.AI_REVIEW_DAILY_LIMIT} per 24 hours). Try again later.`;
}
