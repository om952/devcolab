import { Server, Socket } from "socket.io";
import { prisma } from "@devcolab/database";

const USER_COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"
];

function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

interface CursorData {
  filePath?: string;
  line?: number;
  column?: number;
}

export function setupSocketHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    console.log(`[socket.io] Client connected: ${socket.id}`);

    socket.on("session:join", async ({ sessionId, userId, userName }: { sessionId: string; userId: string; userName: string }) => {
      socket.data.userId = userId;
      socket.data.userName = userName;
      socket.data.sessionId = sessionId;

      socket.join(sessionId);

      await prisma.sessionParticipant.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        update: { leftAt: null },
        create: { sessionId, userId },
      });

      const participants = await prisma.sessionParticipant.findMany({
        where: { sessionId, leftAt: null },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      socket.to(sessionId).emit("user:joined", {
        userId,
        userName,
        color: getUserColor(userId),
        participants: participants.map(p => ({
          id: p.user.id,
          name: p.user.name,
          role: p.user.role,
          color: getUserColor(p.user.id),
        })),
      });

      socket.emit("session:joined", {
        sessionId,
        participants: participants.map(p => ({
          id: p.user.id,
          name: p.user.name,
          role: p.user.role,
          color: getUserColor(p.user.id),
        })),
      });
    });

    socket.on("session:leave", async () => {
      const { sessionId, userId } = socket.data;
      if (!sessionId || !userId) return;

      socket.leave(sessionId);

      await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId },
        data: { leftAt: new Date() },
      });

      socket.to(sessionId).emit("user:left", { userId });
    });

    socket.on("cursor:move", async (data: CursorData) => {
      const { sessionId, userId } = socket.data;
      if (!sessionId || !userId) return;

      await prisma.cursorPresence.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        update: {
          filePath: data.filePath,
          line: data.line,
          column: data.column,
        },
        create: {
          sessionId,
          userId,
          filePath: data.filePath,
          line: data.line,
          column: data.column,
          color: getUserColor(userId),
        },
      });

      socket.to(sessionId).emit("cursor:update", {
        userId,
        userName: socket.data.userName,
        color: getUserColor(userId),
        ...data,
      });
    });

    socket.on("comment:create", async (data: { content: string; category: string; filePath?: string; lineStart?: number; lineEnd?: number }) => {
      const { sessionId, userId } = socket.data;
      if (!sessionId || !userId) return;

      const comment = await prisma.comment.create({
        data: {
          ...data,
          sessionId,
          authorId: userId,
          authorType: "human",
        },
        include: { author: { select: { id: true, name: true, role: true } } },
      });

      io.to(sessionId).emit("comment:created", comment);
    });

    socket.on("comment:reply", async (data: { parentId: string; content: string }) => {
      const { sessionId, userId } = socket.data;
      if (!sessionId || !userId) return;

      const parent = await prisma.comment.findUnique({ where: { id: data.parentId } });
      if (!parent || parent.sessionId !== sessionId) return;

      const reply = await prisma.comment.create({
        data: {
          content: data.content,
          sessionId,
          authorId: userId,
          authorType: "human",
          parentId: data.parentId,
          category: parent.category,
          filePath: parent.filePath,
          lineStart: parent.lineStart,
          lineEnd: parent.lineEnd,
        },
        include: { author: { select: { id: true, name: true, role: true } } },
      });

      io.to(sessionId).emit("comment:created", reply);
    });

    socket.on("disconnect", async () => {
      const { sessionId, userId } = socket.data;
      if (sessionId && userId) {
        await prisma.sessionParticipant.updateMany({
          where: { sessionId, userId },
          data: { leftAt: new Date() },
        });
        await prisma.cursorPresence.deleteMany({
          where: { sessionId, userId },
        });
        socket.to(sessionId).emit("user:left", { userId });
      }
      console.log(`[socket.io] Client disconnected: ${socket.id}`);
    });
  });
}
