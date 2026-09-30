import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createServer, type Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";
import { prisma } from "@devcolab/database";

import { env } from "../../src/lib/env";
import healthRoutes from "../../src/routes/health";
import authRoutes from "../../src/routes/auth";
import sessionRoutes from "../../src/routes/sessions";
import commentRoutes from "../../src/routes/comments";
import fileRoutes from "../../src/routes/files";
import aiReviewRoutes from "../../src/routes/ai-review";
import llmKeyRoutes from "../../src/routes/llm-key";
import { setupSocketHandlers } from "../../src/socket/handlers";

/**
 * Mirrors src/index.ts wiring without the listen/Sentry/reconciliation side
 * effects, so tests drive the same middleware and route stack the app uses.
 */
export function buildTestApp() {
  const app = express();
  const httpServer = createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: env.CORS_ORIGIN } });

  app.set("trust proxy", 0);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.set("io", io);

  app.use(healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/llm-key", llmKeyRoutes);
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/sessions/:sessionId/comments", commentRoutes);
  app.use("/api/sessions/:sessionId/files", fileRoutes);
  app.use("/api/sessions/:sessionId/ai-review", aiReviewRoutes);

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body" });
    return res.status(500).json({ error: "Internal server error" });
  });

  setupSocketHandlers(io);
  return { app, httpServer, io };
}

export async function listen(httpServer: HttpServer): Promise<number> {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test server");
  return address.port;
}

/** True when a Postgres we can migrate against is reachable. */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * The session token from a login/register response. It arrives only as the
 * httpOnly cookie; returning it in the body would hand it to page scripts.
 */
export function sessionToken(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
  const match = cookies.map((c) => /^devcolab_session=([^;]+)/.exec(c)).find(Boolean);
  if (!match) throw new Error("response did not set the session cookie");
  return decodeURIComponent(match[1]);
}

let counter = 0;
export const uniqueEmail = () => `test-${Date.now()}-${counter++}@example.com`;

/** Remove only rows this suite created, so a shared dev DB is left intact. */
export async function cleanupUsers(emails: string[]) {
  if (emails.length === 0) return;
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}
