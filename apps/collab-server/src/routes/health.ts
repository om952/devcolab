import { Router } from "express";
import { prisma } from "@devcolab/database";
import { redis } from "../lib/redis";
import { env } from "../lib/env";
import logger from "../lib/logger";

const router = Router();

/**
 * Liveness — is the process alive? Must not touch downstream dependencies:
 * a database blip should never cause the orchestrator to kill healthy pods.
 */
router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "collab-server", environment: env.NODE_ENV });
});

/**
 * Readiness — can this instance actually serve traffic? Checks the
 * dependencies a request would need, so a starting or degraded instance is
 * pulled from the load balancer rather than served broken responses.
 */
router.get("/health/ready", async (_req, res) => {
  const checks: Record<string, string> = {};
  let ready = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    // Log the cause — a readiness failure with no explanation is very hard to
    // debug from outside the process.
    logger.error({ err }, "Readiness check: database unreachable");
    checks.database = "unreachable";
    ready = false;
  }

  if (redis) {
    try {
      await redis.ping();
      checks.redis = "ok";
    } catch (err) {
      logger.warn({ err }, "Readiness check: redis unreachable");
      checks.redis = "unreachable";
      // Redis backs the socket adapter and rate limits. Without it a single
      // instance still works, so degrade rather than fail readiness.
      checks.redis_impact = "degraded: cross-instance broadcast and rate limits unavailable";
    }
  } else {
    checks.redis = "not configured";
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    service: "collab-server",
    checks,
  });
});

export default router;
