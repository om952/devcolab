import type { Socket } from "socket.io";
import { prisma } from "@devcolab/database";
import { verifyToken } from "./auth";
import logger from "./logger";

export interface SocketIdentity {
  userId: string;
  userName: string;
  role: string;
}

function extractToken(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  return null;
}

/**
 * Socket.IO handshake middleware. Establishes the caller's identity from their
 * JWT so downstream handlers never have to trust client-supplied user ids.
 */
export async function authenticateSocket(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  const token = extractToken(socket);
  if (!token) {
    next(new Error("Unauthorized"));
    return;
  }

  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, name: true, role: true },
    });

    if (!user) {
      next(new Error("Unauthorized"));
      return;
    }

    socket.data.userId = user.id;
    socket.data.userName = user.name;
    socket.data.role = user.role;
    next();
  } catch (err) {
    logger.debug({ err, socketId: socket.id }, "Socket handshake rejected");
    next(new Error("Unauthorized"));
  }
}
