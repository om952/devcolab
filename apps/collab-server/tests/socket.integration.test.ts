import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Server as HttpServer } from "http";
import type { Express } from "express";
import { prisma } from "@devcolab/database";
import { buildTestApp, cleanupUsers, databaseAvailable, listen, uniqueEmail } from "./helpers/app";

const hasDb = await databaseAvailable();
const suite = hasDb ? describe : describe.skip;
if (!hasDb) {
  console.warn("\n[skip] Socket integration tests need Postgres\n");
}

suite("Socket.IO integration", () => {
  let app: Express;
  let httpServer: HttpServer;
  let url: string;
  const createdEmails: string[] = [];
  const sockets: Socket[] = [];

  const connect = (auth: Record<string, unknown>): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = ioClient(url, { auth, reconnection: false, transports: ["websocket"] });
      sockets.push(socket);
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (err) => reject(err));
      setTimeout(() => reject(new Error("timed out")), 8000);
    });

  const waitFor = <T,>(socket: Socket, event: string, ms = 8000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const register = async (role = "author") => {
    const email = uniqueEmail();
    createdEmails.push(email);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, name: `User ${createdEmails.length}`, password: "password123", role });
    return { token: res.body.token as string, user: res.body.user };
  };

  const createSession = async (token: string) => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Socket session" });
    return res.body.id as string;
  };

  beforeAll(async () => {
    const built = buildTestApp();
    app = built.app;
    httpServer = built.httpServer;
    const port = await listen(httpServer);
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await cleanupUsers(createdEmails);
    await prisma.$disconnect();
  });

  describe("handshake authentication", () => {
    it("rejects a connection with no token", async () => {
      await expect(connect({})).rejects.toThrow(/Unauthorized/);
    });

    it("rejects a garbage token", async () => {
      await expect(connect({ token: "not-a-jwt" })).rejects.toThrow(/Unauthorized/);
    });

    it("rejects a token signed with the wrong secret", async () => {
      const forged = jwt.sign({ userId: "11111111-1111-1111-1111-111111111111", role: "author" }, "attacker");
      await expect(connect({ token: forged })).rejects.toThrow(/Unauthorized/);
    });

    it("rejects a correctly signed token for a user that no longer exists", async () => {
      const orphan = jwt.sign(
        { userId: "11111111-1111-1111-1111-111111111111", role: "author" },
        process.env.JWT_SECRET!
      );
      await expect(connect({ token: orphan })).rejects.toThrow(/Unauthorized/);
    });

    it("rejects an expired token", async () => {
      const { user } = await register();
      const expired = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, {
        expiresIn: "-1s",
      });
      await expect(connect({ token: expired })).rejects.toThrow(/Unauthorized/);
    });

    it("accepts a valid token", async () => {
      const { token } = await register();
      const socket = await connect({ token });
      expect(socket.connected).toBe(true);
    });
  });

  describe("session join", () => {
    it("joins a real session and reports participants", async () => {
      const { token, user } = await register();
      const sessionId = await createSession(token);
      const socket = await connect({ token });

      socket.emit("session:join", { sessionId });
      const joined = await waitFor<any>(socket, "session:joined");

      expect(joined.sessionId).toBe(sessionId);
      expect(joined.participants.map((p: any) => p.id)).toContain(user.id);
    });

    it("labels the creator as author and a joiner as reviewer", async () => {
      // Both accounts hold the same account-level role; the labels must come
      // from who created the session, not from the users table.
      const owner = await register();
      const guest = await register();
      const sessionId = await createSession(owner.token);

      const ownerSocket = await connect({ token: owner.token });
      ownerSocket.emit("session:join", { sessionId });
      await waitFor(ownerSocket, "session:joined");

      const guestSocket = await connect({ token: guest.token });
      guestSocket.emit("session:join", { sessionId });
      const joined = await waitFor<any>(guestSocket, "session:joined");

      const roles = Object.fromEntries(joined.participants.map((p: any) => [p.id, p.role]));
      expect(roles[owner.user.id]).toBe("author");
      expect(roles[guest.user.id]).toBe("reviewer");
    });

    it("errors on an unknown session instead of joining", async () => {
      const { token } = await register();
      const socket = await connect({ token });

      socket.emit("session:join", { sessionId: "11111111-1111-1111-1111-111111111111" });
      const err = await waitFor<any>(socket, "error:not_found");
      expect(err.event).toBe("session:join");
    });

    it("rejects a malformed sessionId", async () => {
      const { token } = await register();
      const socket = await connect({ token });

      socket.emit("session:join", { sessionId: "nope" });
      const err = await waitFor<any>(socket, "error:validation");
      expect(err.event).toBe("session:join");
    });
  });

  describe("identity cannot be forged", () => {
    it("attributes comments to the token's user, ignoring a spoofed userId", async () => {
      const attacker = await register();
      const victim = await register();
      const sessionId = await createSession(attacker.token);

      const socket = await connect({ token: attacker.token });
      socket.emit("session:join", { sessionId, userId: victim.user.id, userName: "Victim" });
      await waitFor(socket, "session:joined");

      socket.emit("comment:create", { content: "who am I?", category: "general" });
      const comment = await waitFor<any>(socket, "comment:created");

      // The spoofed userId in the payload must be ignored entirely.
      expect(comment.author.id).toBe(attacker.user.id);
      expect(comment.author.id).not.toBe(victim.user.id);
      expect(comment.authorType).toBe("human");
    });
  });

  describe("broadcast", () => {
    it("delivers a comment to another participant in the same session", async () => {
      const a = await register();
      const b = await register("reviewer");
      const sessionId = await createSession(a.token);

      const socketA = await connect({ token: a.token });
      const socketB = await connect({ token: b.token });

      socketA.emit("session:join", { sessionId });
      await waitFor(socketA, "session:joined");
      socketB.emit("session:join", { sessionId });
      await waitFor(socketB, "session:joined");

      const received = waitFor<any>(socketB, "comment:created");
      socketA.emit("comment:create", { content: "hello from A", category: "bug" });

      const comment = await received;
      expect(comment.content).toBe("hello from A");
      expect(comment.category).toBe("bug");
      expect(comment.author.id).toBe(a.user.id);
    });

    it("does not leak comments across sessions", async () => {
      const a = await register();
      const b = await register();
      const sessionA = await createSession(a.token);
      const sessionB = await createSession(b.token);

      const socketA = await connect({ token: a.token });
      const socketB = await connect({ token: b.token });

      socketA.emit("session:join", { sessionId: sessionA });
      await waitFor(socketA, "session:joined");
      socketB.emit("session:join", { sessionId: sessionB });
      await waitFor(socketB, "session:joined");

      let leaked = false;
      socketB.on("comment:created", () => {
        leaked = true;
      });

      socketA.emit("comment:create", { content: "session A only", category: "general" });
      await waitFor(socketA, "comment:created");
      await new Promise((r) => setTimeout(r, 400));

      expect(leaked).toBe(false);
    });
  });

  describe("payload validation", () => {
    it("rejects an over-long comment", async () => {
      const { token } = await register();
      const sessionId = await createSession(token);
      const socket = await connect({ token });

      socket.emit("session:join", { sessionId });
      await waitFor(socket, "session:joined");

      socket.emit("comment:create", { content: "x".repeat(6000) });
      const err = await waitFor<any>(socket, "error:validation");
      expect(err.event).toBe("comment:create");
    });

    it("ignores a comment sent before joining a session", async () => {
      const { token } = await register();
      const socket = await connect({ token });

      let got = false;
      socket.on("comment:created", () => {
        got = true;
      });
      socket.emit("comment:create", { content: "orphan" });
      await new Promise((r) => setTimeout(r, 400));

      expect(got).toBe(false);
    });
  });
});
