import rateLimit, { type Options, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "./redis";
import { env } from "./env";
import type { AuthRequest } from "./middleware";

/**
 * Redis-backed store so limits hold across instances. Each limiter needs its
 * own store instance (they namespace by prefix).
 */
function makeStore(prefix: string): Store | undefined {
  const client = redis;
  if (!client) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => client.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

const base: Partial<Options> = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
};

/** Brute-force protection for login/register. Keyed by IP. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  store: makeStore("rl:auth:"),
});

/** LLM calls cost money — key by authenticated user, not IP. */
export const aiReviewLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 5,
  store: makeStore("rl:ai:"),
  // Authenticated users get their own bucket; `authenticate` runs first so
  // req.user is populated. Unauthenticated requests never reach here.
  keyGenerator: (req) => (req as AuthRequest).user?.userId ?? req.ip ?? "unknown",
  message: { error: "AI review rate limit reached. Please wait before requesting another review." },
});

/** Broad backstop across the rest of the API. */
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 300,
  store: makeStore("rl:api:"),
});
