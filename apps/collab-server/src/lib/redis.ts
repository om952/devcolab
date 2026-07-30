import { Redis } from "ioredis";
import { env } from "./env";
import logger from "./logger";

/**
 * Shared Redis connection. Used by the rate limiter and (duplicated) by the
 * Socket.IO adapter. Null when REDIS_URL is unset — callers fall back to
 * in-process behaviour, which is only correct for a single instance.
 */
export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false })
  : null;

if (redis) {
  redis.on("error", (err) => logger.error({ err }, "Redis connection error"));
  redis.on("connect", () => logger.info("Redis connected"));
}

export function redactedRedisUrl(): string {
  return env.REDIS_URL ? env.REDIS_URL.replace(/\/\/.*@/, "//<redacted>@") : "";
}
