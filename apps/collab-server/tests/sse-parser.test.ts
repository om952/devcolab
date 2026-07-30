import { describe, expect, it } from "vitest";
import { parseSseStream } from "../src/services/ai-review-runner";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const events = [];
  for await (const event of parseSseStream(streamOf(chunks))) events.push(event);
  return events;
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("SSE stream parser", () => {
  it("parses a single event", async () => {
    expect(await collect([frame({ type: "complete" })])).toEqual([{ type: "complete" }]);
  });

  it("parses several events delivered in one chunk", async () => {
    const events = await collect([
      frame({ type: "agent_complete", agent: "a" }) + frame({ type: "consolidated" }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["agent_complete", "consolidated"]);
  });

  it("reassembles an event split across chunk boundaries", async () => {
    // The realistic failure mode: a frame arrives in pieces.
    const whole = frame({ type: "agent_complete", agent: "security_scan", issues: [1, 2, 3] });
    const events = await collect([whole.slice(0, 12), whole.slice(12, 30), whole.slice(30)]);
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe("security_scan");
  });

  it("handles a split that lands exactly on the frame delimiter", async () => {
    const a = frame({ type: "one" });
    const b = frame({ type: "two" });
    const joined = a + b;
    const cut = a.length - 1; // mid-delimiter
    const events = await collect([joined.slice(0, cut), joined.slice(cut)]);
    expect(events.map((e) => e.type)).toEqual(["one", "two"]);
  });

  it("skips malformed frames without losing valid ones", async () => {
    const events = await collect([
      frame({ type: "good1" }) + "data: {not json}\n\n" + frame({ type: "good2" }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["good1", "good2"]);
  });

  it("ignores comment and non-data lines", async () => {
    const events = await collect([`: keepalive\n\nevent: ping\n\n${frame({ type: "real" })}`]);
    expect(events.map((e) => e.type)).toEqual(["real"]);
  });

  it("handles multibyte characters split across chunks", async () => {
    const whole = frame({ type: "agent_complete", message: "café — naïve" });
    const bytes = new TextEncoder().encode(whole);
    const mid = Math.floor(bytes.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events[0].message).toBe("café — naïve");
  });

  it("yields nothing for an empty stream", async () => {
    expect(await collect([])).toEqual([]);
  });

  it("drops a trailing frame with no terminator", async () => {
    // Truncated tail is incomplete data, not a valid event.
    const events = await collect([frame({ type: "complete" }) + 'data: {"type":"partial"']);
    expect(events.map((e) => e.type)).toEqual(["complete"]);
  });
});
