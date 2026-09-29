import type { Socket } from "socket.io";
import { SESSION_COOKIE, readCookie, resolveToken } from "./auth";
import logger from "./logger";

export interface SocketIdentity {
  userId: string;
  userName: string;
  role: string;
}

/** Browsers send the session cookie; other clients may pass a token instead. */
function extractToken(socket: Socket): string | null {
  const fromCookie = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
  if (fromCookie) return fromCookie;

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
 * token so downstream handlers never have to trust client-supplied user ids.
 *
 * Each socket also joins a per-user room, which is how logout reaches and
 * closes that user's live connections.
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
    const identity = await resolveToken(token);
    if (!identity) {
      next(new Error("Unauthorized"));
      return;
    }

    socket.data.userId = identity.userId;
    socket.data.userName = identity.name;
    socket.data.role = identity.role;
    socket.join(`user:${identity.userId}`);
    next();
  } catch (err) {
    logger.debug({ err, socketId: socket.id }, "Socket handshake rejected");
    next(new Error("Unauthorized"));
  }
}
