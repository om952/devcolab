import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

dotenv.config();

import authRoutes from "./routes/auth";
import sessionRoutes from "./routes/sessions";
import commentRoutes from "./routes/comments";
import fileRoutes from "./routes/files";
import aiReviewRoutes from "./routes/ai-review";
import { setupSocketHandlers } from "./socket/handlers";

const PORT = Number(process.env.PORT) || 4000;
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

app.set("io", io);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "collab-server" });
});

app.use("/api/auth", authRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/sessions/:sessionId/comments", commentRoutes);
app.use("/api/sessions/:sessionId/files", fileRoutes);
app.use("/api/sessions/:id/ai-review", aiReviewRoutes);

setupSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`[collab-server] Listening on http://localhost:${PORT}`);
});

export { io };
