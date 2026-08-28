import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "@devcolab/database";
import { buildTestApp, cleanupUsers, databaseAvailable, uniqueEmail } from "./helpers/app";

const hasDb = await databaseAvailable();
const suite = hasDb ? describe : describe.skip;
if (!hasDb) {
  console.warn("\n[skip] API integration tests need Postgres — start it with `docker compose up -d postgres`\n");
}

suite("REST API integration", () => {
  let app: Express;
  const createdEmails: string[] = [];

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

    it("lets an author upload a file but forbids a reviewer", async () => {
      const author = await register("author");
      const reviewer = await register("reviewer");

      const session = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${author.token}`)
        .send({ title: "RBAC" });

      const asAuthor = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set("Authorization", `Bearer ${author.token}`)
        .send({ filePath: "a.ts", content: "const a = 1;", language: "typescript" });
      expect(asAuthor.status).toBe(201);

      const asReviewer = await request(app)
        .post(`/api/sessions/${session.body.id}/files`)
        .set("Authorization", `Bearer ${reviewer.token}`)
        .send({ filePath: "b.ts", content: "const b = 1;", language: "typescript" });
      expect(asReviewer.status).toBe(403);
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
