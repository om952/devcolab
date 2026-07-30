import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

/**
 * Durability guarantees we depend on for AI review jobs. Exercises BullMQ
 * directly rather than the app wiring, so a failure here points at the queue
 * contract rather than at review logic.
 */

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://localhost:6379";
const QUEUE = "test-ai-review";

async function redisAvailable(): Promise<boolean> {
  const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

const hasRedis = await redisAvailable();
const suite = hasRedis ? describe : describe.skip;
if (!hasRedis) {
  console.warn("\n[skip] Queue tests need Redis — start it with `docker compose up -d redis`\n");
}

suite("AI review job durability", () => {
  let connection: Redis;
  let queue: Queue;

  beforeAll(async () => {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE, { connection: connection.duplicate() });
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    connection.disconnect();
  });

  it("a job added with no worker running is still waiting afterwards", async () => {
    // This is the restart case: producer accepted the work, nothing consumed
    // it yet, and it must not be lost.
    await queue.add("review", { runId: "run-persist" }, { jobId: "run-persist" });

    expect(await queue.getWaitingCount()).toBe(1);

    const job = await queue.getJob("run-persist");
    expect(job?.data.runId).toBe("run-persist");

    await job?.remove();
  });

  it("a worker started later picks up work queued before it existed", async () => {
    await queue.add("review", { runId: "run-late" }, { jobId: "run-late" });

    const processed: string[] = [];
    const worker = new Worker(
      QUEUE,
      async (job) => {
        processed.push(job.data.runId);
      },
      { connection: connection.duplicate() }
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job was never processed")), 10_000);
      worker.on("completed", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await worker.close();

    expect(processed).toEqual(["run-late"]);
  });

  it("uses the run id as the job id, so a duplicate enqueue is a no-op", async () => {
    await queue.add("review", { runId: "run-dupe" }, { jobId: "run-dupe" });
    await queue.add("review", { runId: "run-dupe" }, { jobId: "run-dupe" });

    expect(await queue.getWaitingCount()).toBe(1);
    await (await queue.getJob("run-dupe"))?.remove();
  });

  it("retries a failing job up to the configured attempt limit", async () => {
    let attempts = 0;
    const worker = new Worker(
      QUEUE,
      async () => {
        attempts++;
        throw new Error("boom");
      },
      { connection: connection.duplicate() }
    );

    await queue.add(
      "review",
      { runId: "run-retry" },
      { jobId: "run-retry", attempts: 2, backoff: { type: "fixed", delay: 100 } }
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("job never exhausted its retries")), 15_000);
      worker.on("failed", (job) => {
        if (job && job.attemptsMade >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await worker.close();

    expect(attempts).toBe(2);
  });
});
