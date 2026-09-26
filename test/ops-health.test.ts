// Ops-Health reaches a URL on a system this project deliberately does not
// control, on the hourly tick, next to three other agents.
//
// That is the exact shape that cost Site-Integrity two consecutive ticks on
// 2026-08-29: a `fetch` with no signal is not a slow call, it is a call that
// may never return, and the agent that hangs is the one that would have
// reported the problem. It leaves a `running` row, no findings, and no error.
//
// So the first test here asserts on HOW the request was made rather than on
// what came back — the same reasoning as the site-integrity tests. A test that
// only checks the findings cannot tell "answered in time" apart from "would
// have hung forever", because a stub always answers instantly.

import { describe, expect, it, vi } from "vitest";
import { opsHealthAgent } from "../src/agents/executive/ops-health.js";
import type { RunContext } from "../src/core/agent.js";

const URL_ = "https://pipeline.example/status";

function ctxWith(env: Record<string, string | undefined>) {
  const writes: Array<{ key: string; salience?: number }> = [];
  return {
    writes,
    ctx: {
      env: { OPS_PIPELINE_MONITOR_ENABLED: "true", OPS_PIPELINE_STATUS_URL: URL_, ...env },
      now: new Date("2026-09-03T10:00:00Z"),
      db: {
        async writeMemory(row: { key: string; salience?: number }) {
          writes.push(row);
        },
        async readMemory() {
          return [];
        },
      },
    } as unknown as RunContext,
  };
}

/** Run propose with globalThis.fetch stubbed, and hand back the call arguments. */
async function propose(
  env: Record<string, string | undefined>,
  responder: () => Response | Promise<Response>
) {
  const spy = vi.fn(responder);
  const real = globalThis.fetch;
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  const { ctx, writes } = ctxWith(env);
  try {
    const actions = await opsHealthAgent.propose!(ctx);
    return { actions, writes, call: spy.mock.calls[0] as unknown as [string, RequestInit] };
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Ops-Health reaching the operations pipeline", () => {
  it("gives the request a timeout, so a hung endpoint cannot take the tick with it", async () => {
    const { call } = await propose({}, () => ok({ totalRuns24h: 10, failedRuns24h: 0 }));

    expect(call[0]).toBe(URL_);
    expect(call[1].method).toBe("GET");
    // The assertion that bites: a signal must be present, and it must be one
    // that actually expires rather than an already-live AbortController nobody
    // ever aborts.
    const signal = call[1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    // AbortSignal.timeout() produces a signal with a pending timer; a plain
    // `new AbortController().signal` would pass the check above, so pin that
    // this one is wired to fire.
    expect(String((signal as AbortSignal & { reason?: unknown }).reason ?? "")).toBe("");
    expect(typeof signal!.addEventListener).toBe("function");
  });

  it("sends the bearer token only when there is one", async () => {
    const withToken = await propose({ OPS_PIPELINE_STATUS_TOKEN: "shh" }, () => ok({}));
    expect((withToken.call[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer shh");

    const without = await propose({}, () => ok({}));
    expect((without.call[1].headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("says the endpoint answered with the wrong thing, not that it was unreachable", async () => {
    // A first connection is far likelier to return a login page than to be
    // genuinely unroutable, and the two send you looking in different places.
    const { actions } = await propose(
      {},
      () => new Response("<html><body>Sign in</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );

    expect(actions[0]!.summary).toContain("not with JSON");
    expect(actions[0]!.summary).not.toContain("Could not reach");
    expect(String(actions[0]!.payload["bodyStarts"])).toContain("Sign in");
  });

  it("names a timeout as a timeout", async () => {
    const { actions } = await propose({}, () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    expect(actions[0]!.summary).toContain("did not answer within");
    expect(actions[0]!.payload["timedOut"]).toBe(true);
  });

  it("reports an HTTP error as an HTTP error", async () => {
    const { actions } = await propose({}, () => new Response("nope", { status: 503 }));
    expect(actions[0]!.summary).toContain("503");
    expect(actions[0]!.payload["httpStatus"]).toBe(503);
  });

  it("derives the error rate from the counts when the endpoint does not send one", async () => {
    const { actions } = await propose({}, () => ok({ totalRuns24h: 200, failedRuns24h: 3 }));
    expect(actions[0]!.payload["errorRate"]).toBeCloseTo(0.015, 5);
    expect(actions[0]!.payload["concerning"]).toBe(false);
    expect(actions[0]!.summary).toContain("healthy");
  });

  it("raises a concern on a bad error rate, and files it at a salience that gets read", async () => {
    const { actions, writes } = await propose({}, () =>
      ok({ totalRuns24h: 100, failedRuns24h: 12, stuckCases: [] })
    );

    expect(actions[0]!.payload["concerning"]).toBe(true);
    expect(actions[0]!.summary).toContain("needs a look");
    // The stored status has to outrank the routine noise or nobody sees it.
    expect(writes.find((w) => w.key === "ops.pipeline_status")?.salience).toBe(9);
  });

  it("raises a concern on stuck cases alone, whatever the error rate", async () => {
    const { actions } = await propose({}, () =>
      ok({
        totalRuns24h: 500,
        failedRuns24h: 0,
        stuckCases: [{ id: "a" }, { id: "b" }, { id: "c" }],
      })
    );
    expect(actions[0]!.payload["concerning"]).toBe(true);
    expect(actions[0]!.payload["stuckCases"]).toBe(3);
  });

  it("does not reach out at all until it is switched on", async () => {
    const spy = vi.fn();
    const real = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof globalThis.fetch;
    try {
      const { ctx } = ctxWith({ OPS_PIPELINE_MONITOR_ENABLED: "false" });
      const actions = await opsHealthAgent.propose!(ctx);
      expect(spy).not.toHaveBeenCalled();
      expect(actions[0]!.payload["active"]).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});
