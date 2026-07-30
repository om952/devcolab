import type { Server as HttpServer } from "http";
import type { Server as IOServer } from "socket.io";
import { prisma } from "@devcolab/database";
import { redis } from "./redis";
import { closeQueue } from "./queue";
import logger from "./logger";

/**
 * Drain in-flight work before the process exits.
 *
 * Orchestrators send SIGTERM and then SIGKILL after a grace period. Without
 * this, rolling deploys cut live WebSocket connections and can abandon an
 * in-flight database write.
 */
export function installGracefulShutdown(params: {
  httpServer: HttpServer;
  io: IOServer;
  timeoutMs?: number;
}) {
  const { httpServer, io, timeoutMs = 15_000 } = params;
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received, draining");

    // Hard cap: never hang a deploy waiting on a stuck connection.
    const killTimer = setTimeout(() => {
      logger.error({ timeoutMs }, "Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);
    killTimer.unref();

    try {
      // Tell connected clients to stop before the socket disappears, so the
      // browser can reconnect to another instance instead of erroring.
      io.emit("server:shutdown", { reason: "Server is restarting" });

      // io.close() disconnects every client AND closes the HTTP server it was
      // attached to, so the server may already be down by the time we get here.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      logger.info("Socket.IO closed");

      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) =>
          httpServer.close((err) => (err ? reject(err) : resolve()))
        );
      }
      logger.info("HTTP server closed");

      // Let the worker finish its current job before releasing Redis; an
      // unfinished job is redelivered rather than lost.
      await closeQueue();
      logger.info("Review queue closed");

      await prisma.$disconnect();
      if (redis) await redis.quit();
      logger.info("Connections released, exiting cleanly");

      clearTimeout(killTimer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A crashed process must not linger in a half-broken state serving traffic.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception, shutting down");
    void shutdown("uncaughtException");
  });
}
