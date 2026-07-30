import { Server, Socket } from "socket.io";
import { z } from "zod";
import { prisma } from "@devcolab/database";
import logger from "../lib/logger";
import { authenticateSocket } from "../lib/socket-auth";

const USER_COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"
];

const MAX_COMMENT_LENGTH = 5_000;
/** Cursor moves fire per mouse-move; persist at most this often per socket. */
const CURSOR_PERSIST_INTERVAL_MS = 2_000;

const COMMENT_CATEGORIES = ["bug", "security", "anti_pattern", "test", "general"] as const;

function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

const joinSchema = z.object({
  sessionId: z.string().uuid(),
});

const cursorSchema = z.object({
  filePath: z.string().max(1024).optional(),
  line: z.number().int().nonnegative().max(1_000_000).optional(),
  column: z.number().int().nonnegative().max(100_000).optional(),
});

const commentSchema = z.object({
  content: z.string().min(1).max(MAX_COMMENT_LENGTH),
  category: z.enum(COMMENT_CATEGORIES).default("general"),
  filePath: z.string().max(1024).optional(),
  lineStart: z.number().int().nonnegative().optional(),
  lineEnd: z.number().int().nonnegative().optional(),
});

const replySchema = z.object({
  parentId: z.string().uuid(),
  content: z.string().min(1).max(MAX_COMMENT_LENGTH),
});

async function listParticipants(sessionId: string) {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId, leftAt: null },
    include: { user: { select: { id: true, name: true, role: true } } },
  });

  return participants.map((p) => ({
    id: p.user.id,
    name: p.user.name,
    role: p.user.role,
    color: getUserColor(p.user.id),
  }));
}

export function setupSocketHandlers(io: Server) {
  // Identity is established during the handshake; handlers below never read a
  // user id off the wire.
  io.use(authenticateSocket);

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;
    const userName: string = socket.data.userName;

    logger.debug({ socketId: socket.id, userId }, "Client connected");

    socket.on("session:join", async (payload: unknown) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("error:validation", { event: "session:join", message: "Invalid sessionId" });
        return;
      }

      const { sessionId } = parsed.data;

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true },
      });

      if (!session) {
        socket.emit("error:not_found", { event: "session:join", message: "Session not found" });
        return;
      }

      // Leave any previously joined room so one socket maps to one session.
      if (socket.data.sessionId && socket.data.sessionId !== sessionId) {
        socket.leave(socket.data.sessionId);
      }

      socket.data.sessionId = sessionId;
      socket.join(sessionId);

      await prisma.sessionParticipant.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        update: { leftAt: null },
        create: { sessionId, userId },
      });

      const participants = await listParticipants(sessionId);

      socket.to(sessionId).emit("user:joined", {
        userId,
        userName,
        color: getUserColor(userId),
        participants,
      });

      socket.emit("session:joined", { sessionId, participants });
    });

    socket.on("session:leave", async () => {
      const sessionId: string | undefined = socket.data.sessionId;
      if (!sessionId) return;

      socket.leave(sessionId);
      socket.data.sessionId = undefined;

      await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId },
        data: { leftAt: new Date() },
      });

      socket.to(sessionId).emit("user:left", { userId });
    });

    socket.on("cursor:move", async (payload: unknown) => {
      const sessionId: string | undefined = socket.data.sessionId;
      if (!sessionId) return;

      const parsed = cursorSchema.safeParse(payload);
      if (!parsed.success) return;
      const data = parsed.data;

      // Broadcast every move, but throttle the write-behind so a dragging
      // cursor does not generate a database write per frame.
      socket.to(sessionId).emit("cursor:update", {
        userId,
        userName,
        color: getUserColor(userId),
        ...data,
      });

      const now = Date.now();
      const lastPersist: number = socket.data.lastCursorPersist ?? 0;
      if (now - lastPersist < CURSOR_PERSIST_INTERVAL_MS) return;
      socket.data.lastCursorPersist = now;

      try {
        await prisma.cursorPresence.upsert({
          where: { sessionId_userId: { sessionId, userId } },
          update: { filePath: data.filePath, line: data.line, column: data.column },
          create: {
            sessionId,
            userId,
            filePath: data.filePath,
            line: data.line,
            column: data.column,
            color: getUserColor(userId),
          },
        });
      } catch (err) {
        logger.warn({ err, sessionId, userId }, "Failed to persist cursor presence");
      }
    });

    socket.on("comment:create", async (payload: unknown) => {
      const sessionId: string | undefined = socket.data.sessionId;
      if (!sessionId) return;

      const parsed = commentSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("error:validation", {
          event: "comment:create",
          message: parsed.error.issues[0]?.message ?? "Invalid comment",
        });
        return;
      }

      const data = parsed.data;

      try {
        const comment = await prisma.comment.create({
          data: {
            content: data.content,
            category: data.category,
            filePath: data.filePath,
            lineStart: data.lineStart,
            lineEnd: data.lineEnd,
            sessionId,
            authorId: userId,
            authorType: "human",
          },
          include: { author: { select: { id: true, name: true, role: true } } },
        });

        io.to(sessionId).emit("comment:created", comment);
      } catch (err) {
        logger.error({ err, sessionId, userId }, "Failed to create comment");
        socket.emit("error:server", { event: "comment:create", message: "Could not save comment" });
      }
    });

    socket.on("comment:reply", async (payload: unknown) => {
      const sessionId: string | undefined = socket.data.sessionId;
      if (!sessionId) return;

      const parsed = replySchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("error:validation", { event: "comment:reply", message: "Invalid reply" });
        return;
      }

      const { parentId, content } = parsed.data;

      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent || parent.sessionId !== sessionId) {
        socket.emit("error:not_found", { event: "comment:reply", message: "Parent comment not found" });
        return;
      }

      try {
        const reply = await prisma.comment.create({
          data: {
            content,
            sessionId,
            authorId: userId,
            authorType: "human",
            parentId,
            category: parent.category,
            filePath: parent.filePath,
            lineStart: parent.lineStart,
            lineEnd: parent.lineEnd,
          },
          include: { author: { select: { id: true, name: true, role: true } } },
        });

        io.to(sessionId).emit("comment:created", reply);
      } catch (err) {
        logger.error({ err, sessionId, userId }, "Failed to create reply");
        socket.emit("error:server", { event: "comment:reply", message: "Could not save reply" });
      }
    });

    socket.on("disconnect", async () => {
      const sessionId: string | undefined = socket.data.sessionId;
      if (sessionId) {
        try {
          await prisma.sessionParticipant.updateMany({
            where: { sessionId, userId },
            data: { leftAt: new Date() },
          });
          await prisma.cursorPresence.deleteMany({ where: { sessionId, userId } });
        } catch (err) {
          logger.warn({ err, sessionId, userId }, "Cleanup on disconnect failed");
        }
        socket.to(sessionId).emit("user:left", { userId });
      }
      logger.debug({ socketId: socket.id, userId }, "Client disconnected");
    });
  });
}
