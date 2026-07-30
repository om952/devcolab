import "dotenv/config";
// Must precede every other import: auto-instrumentation patches modules as
// they load, so anything required before this is never traced.
import "./lib/telemetry";

import { randomUUID } from "crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import { Server } from "socket.io";
import pinoHttp from "pino-http";
import * as Sentry from "@sentry/node";
import { createAdapter } from "@socket.io/redis-adapter";

import { env } from "./lib/env";
import logger from "./lib/logger";
import { redis, redactedRedisUrl } from "./lib/redis";
import { apiLimiter, authLimiter } from "./lib/rate-limit";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import sessionRoutes from "./routes/sessions";
import commentRoutes from "./routes/comments";
import fileRoutes from "./routes/files";
import aiReviewRoutes from "./routes/ai-review";
import { setupSocketHandlers } from "./socket/handlers";
import { reconcileStaleRuns, processRun } from "./services/ai-review-runner";
import { startReviewWorker } from "./lib/queue";
import { installGracefulShutdown } from "./lib/shutdown";

// Initialize Sentry (no-op if DSN is not configured)
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === "production" ? 0.2 : 1.0,
  });
  logger.info("Sentry initialized");
}

const app = express();
const httpServer = createServer(app);

// Required for correct client IPs (and therefore correct rate limiting)
// when running behind a load balancer or ingress.
app.set("trust proxy", env.TRUST_PROXY);

const io = new Server(httpServer, {
  cors: {
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
  maxHttpBufferSize: 1e6,
});

// Attach Redis adapter for multi-instance scaling (optional)
if (redis) {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info({ redisUrl: redactedRedisUrl() }, "Socket.IO Redis adapter attached");
} else if (env.NODE_ENV === "production") {
  logger.warn("REDIS_URL unset — Socket.IO and rate limits will not work correctly across multiple instances");
}

// Security headers. CSP is left to the web app; this service only returns JSON.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
app.use(
  pinoHttp({
    logger,
    // Honour an inbound correlation id so a request can be traced across the
    // proxy and both services; generate one otherwise.
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    autoLogging: {
      ignore: (req) => {
        const url = (req as any).url as string | undefined;
        return url === "/health" || url === "/health/ready";
      },
    },
  })
);

app.set("io", io);

// Health probes are registered before the rate limiter so they are never
// throttled — a throttled probe reads as an outage to the orchestrator.
app.use(healthRoutes);

app.use(apiLimiter);

// Routes
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/sessions/:sessionId/comments", commentRoutes);
app.use("/api/sessions/:sessionId/files", fileRoutes);
app.use("/api/sessions/:sessionId/ai-review", aiReviewRoutes);

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // body-parser failures are client errors, not server faults.
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  logger.error({ err }, "Unhandled express error");
  Sentry.captureException(err);
  res.status(500).json({ error: "Internal server error" });
});

// Socket.IO
setupSocketHandlers(io);

// Consume queued review jobs. Runs in-process, but because jobs live in Redis
// they survive a restart and are shared across instances.
startReviewWorker((runId) => processRun(runId, io));

httpServer.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "collab-server started");

  // Runs abandoned by a crash would otherwise sit in `running` forever.
  const sweep = () =>
    reconcileStaleRuns().catch((err) => logger.error({ err }, "Stale run reconciliation failed"));
  sweep();
  setInterval(sweep, env.AI_REVIEW_TIMEOUT_MS).unref();
});

installGracefulShutdown({ httpServer, io });

export { app, io, httpServer };
