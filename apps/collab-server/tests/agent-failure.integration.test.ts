import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@devcolab/database";
import { processRun } from "../src/services/ai-review-runner";
import { databaseAvailable, cleanupUsers, uniqueEmail } from "./helpers/app";

const hasDb = await databaseAvailable();
const suite = hasDb ? describe : describe.skip;
if (!hasDb) {
  console.warn("\n[skip] agent failure tests need Postgres — start it with `docker compose up -d postgres`\n");
}

const ALL_AGENTS = ["bug_detection", "security_scan", "anti_pattern", "test_generation"] as const;

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** Stand in for ai-service, streaming the SSE frames a real run would produce. */
function mockAiService(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  );
}

suite("per-agent failure reporting", () => {
  const createdEmails: string[] = [];
  let sessionId = "";
  let fileId = "";
  let userId = "";

  beforeAll(async () => {
    const email = uniqueEmail();
    createdEmails.push(email);
    const user = await prisma.user.create({
      data: { email, name: "Runner Test", password: "x", role: "author" },
    });
    userId = user.id;
    const session = await prisma.session.create({
      data: { title: "agent failure test", createdById: user.id },
    });
    sessionId = session.id;
    const file = await prisma.codeFile.create({
      data: { sessionId, filePath: "sample.py", content: "x = 1\n", language: "python" },
    });
    fileId = file.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanupUsers(createdEmails);
    await prisma.$disconnect();
  });

  async function runWith(frames: string[]) {
    const run = await prisma.aIReviewRun.create({
      data: {
        sessionId,
        codeFileId: fileId,
        triggeredById: userId,
        status: "pending",
        agentRuns: {
          create: ALL_AGENTS.map((agentType) => ({ sessionId, agentType, status: "pending" as const })),
        },
      },
      select: { id: true },
    });

    mockAiService(frames);
    await processRun(run.id, null);

    return prisma.aIReviewRun.findUnique({
      where: { id: run.id },
      include: { agentRuns: true },
    });
  }

  it("records an agent that failed inside ai-service as failed, not completed", async () => {
    const result = await runWith([
      frame({ type: "agent_complete", agent: "bug_detection", category: "bug", issues: [], error: null }),
      frame({
        type: "agent_complete",
        agent: "security_scan",
        category: "security",
        issues: [],
        error: "timed out after 90s",
      }),
      frame({ type: "agent_complete", agent: "antipattern_analysis", category: "anti_pattern", issues: [], error: null }),
      frame({ type: "agent_complete", agent: "test_generation", category: "test", issues: [], error: null }),
      frame({
        type: "consolidated",
        issues: [],
        summary: "Found 0 issues.",
        agent_errors: [{ agent: "security_scan", error: "timed out after 90s" }],
      }),
    ]);

    const security = result!.agentRuns.find((a) => a.agentType === "security_scan")!;
    expect(security.status).toBe("failed");
    expect(security.error).toContain("timed out");
  });

  it("does not mark healthy agents as failed", async () => {
    const result = await runWith([
      frame({
        type: "agent_complete",
        agent: "security_scan",
        category: "security",
        issues: [],
        error: "boom",
      }),
      frame({ type: "agent_complete", agent: "bug_detection", category: "bug", issues: [], error: null }),
      frame({ type: "agent_complete", agent: "antipattern_analysis", category: "anti_pattern", issues: [], error: null }),
      frame({ type: "agent_complete", agent: "test_generation", category: "test", issues: [], error: null }),
      frame({ type: "consolidated", issues: [], summary: "s", agent_errors: [] }),
    ]);

    const healthy = result!.agentRuns.filter((a) => a.agentType !== "security_scan");
    expect(healthy).toHaveLength(3);
    for (const agent of healthy) {
      expect(agent.status).toBe("completed");
      expect(agent.error).toBeNull();
    }
  });

  it("marks the whole run degraded when any agent failed", async () => {
    const result = await runWith([
      frame({ type: "agent_complete", agent: "bug_detection", category: "bug", issues: [], error: "boom" }),
      frame({ type: "agent_complete", agent: "security_scan", category: "security", issues: [], error: null }),
      frame({ type: "agent_complete", agent: "antipattern_analysis", category: "anti_pattern", issues: [], error: null }),
      frame({ type: "agent_complete", agent: "test_generation", category: "test", issues: [], error: null }),
      // Deliberately empty: degradation must be derived from the per-agent
      // events, not only from the consolidated summary.
      frame({ type: "consolidated", issues: [], summary: "s", agent_errors: [] }),
    ]);

    expect(result!.degraded).toBe(true);
    expect(result!.status).toBe("completed");
  });

  it("leaves a fully healthy run undegraded", async () => {
    const result = await runWith([
      ...ALL_AGENTS.map((_, i) =>
        frame({
          type: "agent_complete",
          agent: ["bug_detection", "security_scan", "antipattern_analysis", "test_generation"][i],
          category: ["bug", "security", "anti_pattern", "test"][i],
          issues: [],
          error: null,
        })
      ),
      frame({ type: "consolidated", issues: [], summary: "s", agent_errors: [] }),
    ]);

    expect(result!.degraded).toBe(false);
    expect(result!.agentRuns.every((a) => a.status === "completed")).toBe(true);
  });
});
