import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "@devcolab/database";
import { env } from "../src/lib/env";
import { buildTestApp, cleanupUsers, databaseAvailable, uniqueEmail } from "./helpers/app";

const hasDb = await databaseAvailable();
const suite = hasDb ? describe : describe.skip;
if (!hasDb) {
  console.warn("\n[skip] API integration tests need Postgres — start it with `docker compose up -d postgres`\n");
}

suite("REST API integration", () => {
  let app: Express;
  const createdEmails: string[] = [];

  /**
   * The `role` argument is deliberately still sent. Registration ignores it —
   * everyone is a reviewer — so passing it here keeps the call sites readable
   * while continuously exercising the fact that it has no effect.
   */
  const register = async (role: string) => {
    const email = uniqueEmail();
    createdEmails.push(email);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, name: "Test User", password: "password123", role });
    return { email, token: res.body.token as string, user: res.body.user, res };
  };

  beforeAll(() => {
    app = buildTestApp().app;
  });

  afterAll(async () => {
    await cleanupUsers(createdEmails);
    await prisma.$disconnect();
  });

  describe("health probes", () => {
    it("liveness responds without touching dependencies", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("collab-server");
    });

    it("readiness reports on the database", async () => {
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.checks.database).toBe("ok");
    });

    it("readiness is not rate limited", async () => {
      // A throttled probe would read as an outage to the orchestrator.
      const codes = await Promise.all(
        Array.from({ length: 30 }, () => request(app).get("/health/ready").then((r) => r.status))
      );
      expect(codes.every((c) => c === 200)).toBe(true);
    });
  });

  describe("auth", () => {
    it("registers a user and returns a token, never the password", async () => {
      const { res } = await register("author");
      expect(res.status).toBe(201);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.password).toBeUndefined();
    });

    it("rejects a duplicate email", async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      const body = { email, name: "Dup", password: "password123" };
      expect((await request(app).post("/api/auth/register").send(body)).status).toBe(201);
      expect((await request(app).post("/api/auth/register").send(body)).status).toBe(400);
    });

    it("rejects a weak password and a malformed email", async () => {
      const weak = await request(app)
        .post("/api/auth/register")
        .send({ email: uniqueEmail(), name: "X", password: "123" });
      expect(weak.status).toBe(400);

      const bad = await request(app)
        .post("/api/auth/register")
        .send({ email: "not-an-email", name: "X", password: "password123" });
      expect(bad.status).toBe(400);
    });

    it("requires at least 8 characters and says so in plain words", async () => {
      const short = await request(app)
        .post("/api/auth/register")
        .send({ email: uniqueEmail(), name: "Test User", password: "abc1234" });
      expect(short.status).toBe(400);
      expect(short.body.error).toBe("Password must be at least 8 characters");

      const email = uniqueEmail();
      createdEmails.push(email);
      const ok = await request(app)
        .post("/api/auth/register")
        .send({ email, name: "Test User", password: "abcd1234" });
      expect(ok.status).toBe(201);
    });

    it("still lets an account created under the old 6-character rule sign in", async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      await prisma.user.create({
        data: { email, name: "Legacy", password: await bcrypt.hash("abc123", 10), role: "reviewer" },
      });

      const res = await request(app).post("/api/auth/login").send({ email, password: "abc123" });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    });

    it("logs in with correct credentials and rejects a wrong password", async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      await request(app).post("/api/auth/register").send({ email, name: "Login User", password: "password123" });

      expect((await request(app).post("/api/auth/login").send({ email, password: "password123" })).status).toBe(200);

      const wrong = await request(app).post("/api/auth/login").send({ email, password: "wrongpassword" });
      expect(wrong.status).toBe(400);
      // Must not reveal whether the account exists.
      expect(wrong.body.error).toBe("Invalid credentials");
    });

    it("gives the same error for an unknown account", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password: "password123" });
      expect(res.body.error).toBe("Invalid credentials");
    });
  });

  describe("authentication guards", () => {
    it.each([
      ["GET", "/api/sessions"],
      ["POST", "/api/sessions"],
    ])("rejects unauthenticated %s %s", async (method, path) => {
      const res = await (method === "GET" ? request(app).get(path) : request(app).post(path).send({ title: "x" }));
      expect(res.status).toBe(401);
    });

    it("rejects a malformed and a forged token", async () => {
      expect((await request(app).get("/api/sessions").set("Authorization", "Bearer nonsense")).status).toBe(401);
      expect((await request(app).get("/api/sessions").set("Authorization", "Basic abc")).status).toBe(401);
    });
  });

  describe("sessions and RBAC", () => {
    it("creates a session and enrolls the creator as a participant", async () => {
      const { token, user } = await register("author");
      const res = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Review PR 42", description: "desc" });

      expect(res.status).toBe(201);
      const participants = await prisma.sessionParticipant.findMany({ where: { sessionId: res.body.id } });
      expect(participants.map((p) => p.userId)).toContain(user.id);
    });

    it("lets the session creator upload a file but forbids everyone else", async () => {
      // Ownership, not role: every account registers as a reviewer now, so if
      // this still worked on a role check nobody could ever upload anything.
      const creator = await register("author");
      const other = await register("reviewer");
      expect(creator.user.role).toBe("reviewer");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${creator.token}`)
        .send({ title: "RBAC" });

      const asCreator = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set("Authorization", `Bearer ${creator.token}`)
        .send({ filePath: "a.ts", content: "const a = 1;", language: "typescript" });
      expect(asCreator.status).toBe(201);

      const asOther = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({ filePath: "b.ts", content: "const b = 1;", language: "typescript" });
      expect(asOther.status).toBe(403);

      // Batch upload must be gated identically; it writes through the same path.
      const batchAsOther = await request(app)
        .post(`/api/sessions/${session.body.id}/files/batch`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({ files: [{ filePath: "c.ts", content: "const c = 1;" }] });
      expect(batchAsOther.status).toBe(403);
    });

    it("ignores a client-supplied role at registration", async () => {
      // Registration used to write whatever role the client asked for, so a
      // stranger could sign up as an author, or as ai_reviewer — the account
      // that authors AI comments — and appear as the AI in the participant list.
      for (const attempted of ["author", "ai_reviewer", "admin"]) {
        const email = uniqueEmail();
        createdEmails.push(email);
        const res = await request(app)
          .post("/api/auth/register")
          .send({ email, name: "Role Probe", password: "password123", role: attempted });

        expect(res.status).toBe(201);
        expect(res.body.user.role).toBe("reviewer");

        const stored = await prisma.user.findUnique({ where: { email } });
        expect(stored?.role).toBe("reviewer");
      }
    });

    it("returns 404 for a file belonging to another session", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };

      const s1 = await request(app).post("/api/sessions").set(auth).send({ title: "S1" });
      const s2 = await request(app).post("/api/sessions").set(auth).send({ title: "S2" });
      const file = await request(app)
        .post(`/api/sessions/${s1.body.id}/files`)
        .set(auth)
        .send({ filePath: "x.ts", content: "x", language: "typescript" });

      const cross = await request(app).get(`/api/sessions/${s2.body.id}/files/${file.body.id}`).set(auth);
      expect(cross.status).toBe(404);
    });

    it("stops a non-creator from deleting a session", async () => {
      const owner = await register("author");
      const other = await register("reviewer");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Owned" });

      const res = await request(app)
        .delete(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${other.token}`);
      expect(res.status).toBe(403);
    });

    it("stops another AUTHOR from deleting someone else's session", async () => {
      // The role must not substitute for ownership: previously any user with
      // the author role could delete any session.
      const owner = await register("author");
      const otherAuthor = await register("author");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Author-owned" });

      const res = await request(app)
        .delete(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${otherAuthor.token}`);
      expect(res.status).toBe(403);

      expect(await prisma.session.findUnique({ where: { id: session.body.id } })).not.toBeNull();
    });

    it("stops another AUTHOR from editing someone else's session", async () => {
      const owner = await register("author");
      const otherAuthor = await register("author");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Author-owned edit" });

      const res = await request(app)
        .patch(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${otherAuthor.token}`)
        .send({ title: "hijacked" });
      expect(res.status).toBe(403);
    });

    it("refuses to reassign ownership through PATCH", async () => {
      const owner = await register("author");
      const attacker = await register("author");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Ownership" });

      // Unknown keys are rejected outright rather than written to the row.
      const res = await request(app)
        .patch(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ createdById: attacker.user.id });
      expect(res.status).toBe(400);

      const after = await prisma.session.findUnique({ where: { id: session.body.id } });
      expect(after!.createdById).toBe(owner.user.id);
    });

    it("allows the creator to patch permitted fields", async () => {
      const owner = await register("author");
      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Editable" });

      const res = await request(app)
        .patch(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Renamed", status: "completed" });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Renamed");
      expect(res.body.status).toBe("completed");
    });
  });

  describe("session visibility", () => {
    it("lists only sessions the caller created", async () => {
      const mine = await register("author");
      const theirs = await register("author");

      const own = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${mine.token}`)
        .send({ title: "Mine" });
      const other = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${theirs.token}`)
        .send({ title: "Theirs" });

      const list = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${mine.token}`);

      const ids = list.body.map((s: any) => s.id);
      expect(ids).toContain(own.body.id);
      expect(ids).not.toContain(other.body.id);
    });

    it("shows a session on your dashboard once you have joined it", async () => {
      const owner = await register("author");
      const guest = await register("reviewer");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Shared by link" });

      // Not listed before opening it.
      const before = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${guest.token}`);
      expect(before.body.map((s: any) => s.id)).not.toContain(session.body.id);

      // Anyone holding the id may open it — this is the link-share model.
      const open = await request(app)
        .get(`/api/sessions/${session.body.id}`)
        .set("Authorization", `Bearer ${guest.token}`);
      expect(open.status).toBe(200);

      // ...and it is listed from then on.
      const after = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${guest.token}`);
      expect(after.body.map((s: any) => s.id)).toContain(session.body.id);
    });

    it("does not leak other people's sessions to a brand new user", async () => {
      const busy = await register("author");
      await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${busy.token}`)
        .send({ title: "Existing work" });

      const fresh = await register("reviewer");
      const list = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${fresh.token}`);

      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);
    });

    it("requires authentication to list sessions", async () => {
      expect((await request(app).get("/api/sessions")).status).toBe(401);
    });
  });

  describe("comments", () => {
    it("creates a human-authored comment and lists it", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "C" });

      const created = await request(app)
        .post(`/api/sessions/${session.body.id}/comments`)
        .set(auth)
        .send({ content: "Looks good", category: "general" });

      expect(created.status).toBe(201);
      expect(created.body.authorType).toBe("human");

      const list = await request(app).get(`/api/sessions/${session.body.id}/comments`).set(auth);
      expect(list.body.map((c: any) => c.id)).toContain(created.body.id);
    });

    it("rejects an empty comment and an unknown category", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "C2" });

      expect(
        (await request(app).post(`/api/sessions/${session.body.id}/comments`).set(auth).send({ content: "" })).status
      ).toBe(400);

      expect(
        (
          await request(app)
            .post(`/api/sessions/${session.body.id}/comments`)
            .set(auth)
            .send({ content: "hi", category: "nonsense" })
        ).status
      ).toBe(400);
    });
  });

  describe("AI review endpoints", () => {
    it("validates fileId and 404s on an unknown file", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "AI" });

      const badId = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: "not-a-uuid" });
      expect(badId.status).toBe(400);

      const missing = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: "11111111-1111-1111-1111-111111111111" });
      expect(missing.status).toBe(404);
    });

    it("returns 202 with a runId and persists the run plus four agent rows", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "AI run" });
      const file = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set(auth)
        .send({ filePath: "s.ts", content: 'const password = "hunter2";\n', language: "typescript" });

      const res = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: file.body.id });

      expect(res.status).toBe(202);
      expect(res.body.runId).toBeTruthy();

      const run = await prisma.aIReviewRun.findUnique({
        where: { id: res.body.runId },
        include: { agentRuns: true },
      });
      expect(run).not.toBeNull();
      expect(run!.agentRuns).toHaveLength(4);
      expect(run!.agentRuns.map((a) => a.agentType).sort()).toEqual([
        "anti_pattern",
        "bug_detection",
        "security_scan",
        "test_generation",
      ]);
    });

    it("exposes the run for polling and lists run history", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "AI poll" });
      const file = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set(auth)
        .send({ filePath: "p.ts", content: "const a = 1;\n", language: "typescript" });

      const started = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: file.body.id });

      const poll = await request(app)
        .get(`/api/sessions/${session.body.id}/ai-review/${started.body.runId}`)
        .set(auth);
      expect(poll.status).toBe(200);
      expect(poll.body.agentRuns).toHaveLength(4);

      const list = await request(app).get(`/api/sessions/${session.body.id}/ai-review`).set(auth);
      expect(list.body.runs.map((r: any) => r.id)).toContain(started.body.runId);
      expect(list.body).toHaveProperty("nextCursor");
    });

    it("attaches a second trigger to the in-flight run instead of starting another", async () => {
      const author = await register("author");
      const auth = { Authorization: `Bearer ${author.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "AI dedupe" });
      const file = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set(auth)
        .send({ filePath: "d.ts", content: "const a = 1;\n", language: "typescript" });

      const first = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: file.body.id });
      const second = await request(app)
        .post(`/api/sessions/${session.body.id}/ai-review`)
        .set(auth)
        .send({ fileId: file.body.id });

      // The first run may finish before the second call lands; only assert
      // dedupe when the second reports the run was still active.
      if (second.body.alreadyRunning) {
        expect(second.body.runId).toBe(first.body.runId);
      }
      expect(second.status).toBe(202);
    });
  });

  describe("daily AI review limit", () => {
    /** Pretend this user already started `count` reviews in the last 24 hours. */
    const seedRuns = (sessionId: string, userId: string, count: number) =>
      prisma.aIReviewRun.createMany({
        data: Array.from({ length: count }, () => ({
          sessionId,
          triggeredById: userId,
          status: "completed" as const,
        })),
      });

    const setup = async () => {
      const user = await register("reviewer");
      const auth = { Authorization: `Bearer ${user.token}` };
      const session = await request(app).post("/api/sessions").set(auth).send({ title: "Quota" });
      return { user, auth, sessionId: session.body.id as string };
    };

    const addFile = async (auth: Record<string, string>, sessionId: string, name: string) => {
      const res = await request(app)
        .post(`/api/sessions/${sessionId}/files`)
        .set(auth)
        .send({ filePath: name, content: "const x = 1;\n", language: "typescript" });
      return res.body.id as string;
    };

    it("refuses a single review once the day's allowance is used", async () => {
      const { user, auth, sessionId } = await setup();
      const fileId = await addFile(auth, sessionId, "a.ts");
      await seedRuns(sessionId, user.user.id, env.AI_REVIEW_DAILY_LIMIT);

      const res = await request(app).post(`/api/sessions/${sessionId}/ai-review`).set(auth).send({ fileId });

      expect(res.status).toBe(429);
      expect(res.body.error).toMatch(/daily AI review limit/i);
    });

    it("trims a folder review to what is left instead of refusing it outright", async () => {
      const { user, auth, sessionId } = await setup();
      const ids = [
        await addFile(auth, sessionId, "a.ts"),
        await addFile(auth, sessionId, "b.ts"),
        await addFile(auth, sessionId, "c.ts"),
      ];
      await seedRuns(sessionId, user.user.id, env.AI_REVIEW_DAILY_LIMIT - 1);

      const res = await request(app)
        .post(`/api/sessions/${sessionId}/ai-review/batch`)
        .set(auth)
        .send({ fileIds: ids });

      expect(res.status).toBe(202);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.skipped).toHaveLength(2);
      expect(res.body.skipped[0].reason).toBe("over your daily review limit");
    });

    it("does not count another user's reviews against you", async () => {
      const other = await setup();
      await seedRuns(other.sessionId, other.user.user.id, env.AI_REVIEW_DAILY_LIMIT);

      const { auth, sessionId } = await setup();
      const fileId = await addFile(auth, sessionId, "a.ts");
      const res = await request(app).post(`/api/sessions/${sessionId}/ai-review`).set(auth).send({ fileId });

      expect(res.status).toBe(202);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the caller's identity for a valid token", async () => {
      const { token, user, email } = await register("reviewer");

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: user.id, email, role: "reviewer" });
      // The password hash must never leave the server.
      expect(res.body.password).toBeUndefined();
    });

    it("rejects a missing, malformed or forged token", async () => {
      const none = await request(app).get("/api/auth/me");
      expect(none.status).toBe(401);

      const malformed = await request(app).get("/api/auth/me").set("Authorization", "Bearer nope");
      expect(malformed.status).toBe(401);

      // Correct shape, wrong signature.
      const forged = await request(app)
        .get("/api/auth/me")
        .set(
          "Authorization",
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
            "eyJ1c2VySWQiOiJmYWtlIiwicm9sZSI6ImF1dGhvciJ9.badsignature"
        );
      expect(forged.status).toBe(401);
    });

    it("rejects a validly signed token for an account that no longer exists", async () => {
      const { token, user } = await register("reviewer");
      await prisma.user.delete({ where: { id: user.id } });

      // The signature still verifies — only a database lookup can catch this.
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("reports the role from the database, not the token claim", async () => {
      const { token, user } = await register("reviewer");
      await prisma.user.update({ where: { id: user.id }, data: { role: "author" } });

      // The token still carries role=reviewer; /me must not repeat it back.
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("author");
    });
  });

  describe("concurrent enrolment", () => {
    it("survives simultaneous opens of the same session by the same user", async () => {
      const owner = await register("author");
      const guest = await register("reviewer");

      const session = await request(app)
        .post("/api/sessions")
        .set({ Authorization: `Bearer ${owner.token}` })
        .send({ title: "Concurrent open" });

      // Opening a session enrols the caller. A real browser does this over
      // HTTP and over the socket at the same time, so both insert the same
      // (session, user) pair concurrently. Losing that race threw an
      // unhandled P2002, and because Express 4 does not await async handlers
      // the request was left hanging with no response at all.
      const opens = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app)
            .get(`/api/sessions/${session.body.id}`)
            .set({ Authorization: `Bearer ${guest.token}` })
        )
      );

      expect(opens.map((r) => r.status)).toEqual(Array(8).fill(200));

      const rows = await prisma.sessionParticipant.count({
        where: { sessionId: session.body.id, userId: guest.user.id },
      });
      expect(rows).toBe(1);
    });
  });
});
