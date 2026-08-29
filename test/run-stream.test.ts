// How a manual run reaches the caller, and why it is a stream.
//
// Written after the third attempt at this route. Holding the run in an ordinary
// request produced a 524 at the edge while the Worker carried on spending.
// Returning 202 and handing the work to waitUntil() fixed the caller and killed
// the run: waitUntil extends a Worker for at most thirty seconds past the
// response, so Competitive Intelligence died half a minute in, mid research
// call, leaving a status board that read "started" and looked exactly like an
// agent still thinking.
//
// A Worker streaming a response body to a connected client has no duration
// limit. These tests cover the three properties that makes that safe: lines
// reach the caller as they happen, a silent stretch still emits bytes, and a
// failed run closes the stream instead of leaving the caller hanging.

import { describe, expect, it } from "vitest";
import { runStream } from "../src/routes/api.js";

/** Drain a stream to the lines it produced. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text.split("\n").filter(Boolean);
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a run delivered as a stream", () => {
  it("sends each line as the run produces it, then closes", async () => {
    const lines = await drain(
      runStream(async (send) => {
        send("competitive_intel: researching");
        send("competitive_intel: 4 candidates");
        return JSON.stringify({ proposed: 4 });
      })
    );

    expect(lines).toEqual([
      "competitive_intel: researching",
      "competitive_intel: 4 candidates",
      'done {"proposed":4}',
    ]);
  });

  it("keeps writing through a silent stretch", async () => {
    // The property that matters most and the one nothing else covers: a
    // research pass thinks for minutes without logging, and a connection
    // carrying nothing is what the edge cuts at around a hundred seconds.
    const lines = await drain(
      runStream(async () => {
        await tick(90);
        return "{}";
      }, 20)
    );

    const beats = lines.filter((line) => line.startsWith("..."));
    expect(beats.length).toBeGreaterThan(1);
    expect(lines[lines.length - 1]).toBe("done {}");
  });

  it("closes on failure rather than leaving the caller waiting", async () => {
    const lines = await drain(
      runStream(async () => {
        throw new Error("budget ceiling reached");
      })
    );

    expect(lines).toEqual(["failed: budget ceiling reached"]);
  });

  it("stops beating when the caller hangs up", async () => {
    // A heartbeat left running against an abandoned stream ticks forever.
    const stream = runStream(async () => {
      await tick(200);
      return "{}";
    }, 10);

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    // If cancel did not clear the interval this would keep enqueueing into a
    // closed controller; the run's own completion path must still be safe.
    await expect(tick(60)).resolves.toBeUndefined();
  });
});
