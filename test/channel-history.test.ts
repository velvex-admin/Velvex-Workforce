import { describe, expect, it } from "vitest";
import { readChannelHistory } from "../src/agents/marketing/channel-agent.js";
import type { RunContext } from "../src/core/agent.js";

/** A context whose only job is to hand back a canned report list. */
function ctxWith(rows: unknown[]): RunContext {
  return {
    db: { listReports: async () => rows },
  } as unknown as RunContext;
}

const row = (over: Record<string, unknown>) => ({
  channel: "x",
  action_type: "publish_post",
  outcome: "executed",
  created_at: "2026-08-21T07:00:00.000Z",
  summary: "a post",
  detail: {},
  ...over,
});

// A failed publish is not a post. Counting one set the minimum-gap clock, so a
// single refusal from X suppressed publishing for the next 30 hours — and did
// it silently, because the gap is a quiet "not yet" rather than an error.
describe("readChannelHistory", () => {
  it("ignores a failed publish when deciding when we last posted", async () => {
    const history = await readChannelHistory("x", ctxWith([row({ outcome: "failed" })]));
    expect(history.lastPublishedAt).toBeNull();
    expect(history.recentPosts).toEqual([]);
  });

  it("counts a successful publish", async () => {
    const history = await readChannelHistory("x", ctxWith([row({})]));
    expect(history.lastPublishedAt).toBe(Date.parse("2026-08-21T07:00:00.000Z"));
    expect(history.recentPosts).toHaveLength(1);
  });

  it("takes the newest success, not the newest attempt", async () => {
    const history = await readChannelHistory(
      "x",
      ctxWith([
        row({ outcome: "failed", created_at: "2026-08-22T13:31:00.000Z" }),
        row({ created_at: "2026-08-20T09:00:00.000Z" }),
      ])
    );
    expect(history.lastPublishedAt).toBe(Date.parse("2026-08-20T09:00:00.000Z"));
  });

  it("never feeds copy that was never published back as recent history", async () => {
    const history = await readChannelHistory(
      "x",
      ctxWith([row({ outcome: "failed", detail: { text: "never went out" } })])
    );
    expect(history.recentPosts.join(" ")).not.toContain("never went out");
  });

  it("ignores other channels and other action types", async () => {
    const history = await readChannelHistory(
      "x",
      ctxWith([row({ channel: "linkedin" }), row({ action_type: "draft_content" })])
    );
    expect(history.lastPublishedAt).toBeNull();
  });
});
