// The propose -> classify -> execute-or-queue loop, and the Chief-of-Staff
// filter that decides which table a piece of work lands in.

import { describe, expect, it, vi } from "vitest";
import { runAgent, type AgentDefinition, type RunContext } from "../src/core/agent.js";
import type { ProposedAction } from "../src/core/types.js";
import { marketingAnalyticsAgent } from "../src/agents/marketing/analytics.js";
import { fixedJudge } from "./helpers.js";

function fakeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    env: {} as RunContext["env"],
    db: {} as RunContext["db"],
    claude: {} as RunContext["claude"],
    judge: fixedJudge("praise"),
    runId: "run-1",
    now: new Date("2026-08-18T12:00:00Z"),
    trigger: "manual",
    log: () => {},
    ...overrides,
  };
}

function agentThatProposes(actions: ProposedAction[], overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "content",
    name: "Test Agent",
    batch: "marketing",
    description: "test",
    model: "claude-sonnet-5",
    effort: "medium",
    cadence: "manual",
    approvedChannels: ["internal"],
    routineRules: [
      {
        id: "test.routine",
        describe: "observations are routine",
        classification: "routine",
        test: (a) => (a.type === "observation" ? "routine" : null),
      },
    ],
    approvalRules: [],
    propose: async () => actions,
    execute: async () => ({ outcome: "executed" }),
    ...overrides,
  };
}

function coordinator() {
  return {
    reports: [] as unknown[],
    escalations: [] as unknown[],
    async receiveReport(report: unknown) {
      this.reports.push(report);
    },
    async escalate(args: unknown) {
      this.escalations.push(args);
      return { queued: true, approvalId: "approval-1" };
    },
  };
}

describe("the agent run loop", () => {
  it("executes routine work and reports it", async () => {
    const coord = coordinator();
    const agent = agentThatProposes([
      { type: "observation", summary: "looked at something", payload: {} },
    ]);

    const result = await runAgent(agent, coord, fakeContext());

    expect(result.executed).toBe(1);
    expect(result.queued).toBe(0);
    expect(coord.reports).toHaveLength(1);
    expect(coord.escalations).toHaveLength(0);
  });

  it("queues anything outside routine scope instead of doing it", async () => {
    const coord = coordinator();
    const agent = agentThatProposes([
      { type: "publish_post", summary: "post something", payload: {} },
    ]);

    const result = await runAgent(agent, coord, fakeContext());

    expect(result.executed).toBe(0);
    expect(result.queued).toBe(1);
    expect(coord.escalations).toHaveLength(1);
  });

  it("never calls execute for an action it queued", async () => {
    const execute = vi.fn(async () => ({ outcome: "executed" as const }));
    const agent = agentThatProposes(
      [{ type: "publish_post", summary: "post something", payload: {} }],
      { execute }
    );

    await runAgent(agent, coordinator(), fakeContext());
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops an observe-only agent from acting even if it tries", async () => {
    const coord = coordinator();
    const execute = vi.fn(async () => ({ outcome: "executed" as const }));
    const rogue = agentThatProposes(
      [{ type: "publish_post", summary: "publish something", channel: "internal", payload: {} }],
      { observeOnly: true, execute }
    );

    const result = await runAgent(rogue, coord, fakeContext());

    expect(execute).not.toHaveBeenCalled();
    expect(result.queued).toBe(1);
    expect(
      (coord.escalations[0] as { decision: { ruleId: string } }).decision.ruleId
    ).toBe("content.observe_only_violation");
  });

  it("reports a failure rather than swallowing it", async () => {
    const coord = coordinator();
    const agent = agentThatProposes([
      { type: "observation", summary: "will fail", payload: {} },
    ], {
      execute: async () => {
        throw new Error("connector exploded");
      },
    });

    const result = await runAgent(agent, coord, fakeContext());

    expect(result.failed).toBe(1);
    expect((coord.reports[0] as { outcome: string }).outcome).toBe("failed");
    expect((coord.reports[0] as { error: string }).error).toContain("connector exploded");
  });

  it("skips agents that are an external build", async () => {
    const coord = coordinator();
    const propose = vi.fn(async () => []);
    const external = agentThatProposes([], { externalBuild: true, propose });

    const result = await runAgent(external, coord, fakeContext());

    expect(propose).not.toHaveBeenCalled();
    expect(result.proposed).toBe(0);
  });

  it("reports, rather than crashes, when an agent cannot work out what to do", async () => {
    const coord = coordinator();
    const agent = agentThatProposes([], {
      propose: async () => {
        throw new Error("no data source");
      },
    });

    const result = await runAgent(agent, coord, fakeContext());

    expect(result.failed).toBe(1);
    expect(result.error).toContain("no data source");
    expect((coord.reports[0] as { outcome: string }).outcome).toBe("failed");
  });
});

describe("the roster", () => {
  it("keeps Marketing Analytics observe-only, as the doc requires", () => {
    expect(marketingAnalyticsAgent.observeOnly).toBe(true);
    expect(marketingAnalyticsAgent.approvalRules).toHaveLength(0);
  });
});

describe("the live thought trail", () => {
  /** A memory table just real enough for state.read/state.write. */
  function fakeDb() {
    const rows = new Map<string, unknown>();
    const calls = { reads: 0, writes: 0 };
    return {
      calls,
      db: {
        async readMemory({ keys }: { keys: string[] }) {
          calls.reads += 1;
          const key = keys[0] ?? "";
          return rows.has(key) ? [{ detail: { value: rows.get(key) } }] : [];
        },
        async writeMemory({ key, detail }: { key: string; detail: Record<string, unknown> }) {
          calls.writes += 1;
          rows.set(key, detail["value"]);
        },
      } as unknown as RunContext["db"],
      board: () =>
        (rows.get("runtime.agent_status") ?? {}) as Record<
          string,
          { latestThought?: string; thoughts?: Array<{ text: string }> }
        >,
    };
  }

  it("puts a line on the board while propose is still running", async () => {
    // The bug this exists for: ctx.log used to push into an array that was only
    // written around propose(), never inside it. Every agent that finishes in
    // seconds looked live; Competitive Intelligence, whose entire run happens
    // inside propose(), sat on "started" for ten minutes and a watcher could
    // not tell that apart from a hang.
    const { db, board } = fakeDb();
    let boardMidRun: Record<string, { latestThought?: string }> = {};

    const agent = agentThatProposes([], {
      propose: async (runCtx: RunContext) => {
        runCtx.log("halfway through the long bit");
        // Yield so the fire-and-forget flush can land, the way real awaited
        // work inside propose() would.
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Deep copy: the board is stored by reference and keeps being mutated,
        // so holding the live object would just show the final state.
        boardMidRun = JSON.parse(JSON.stringify(board()));
        return [];
      },
    });

    await runAgent(agent, coordinator() as never, fakeContext({ db }));

    expect(boardMidRun["content"]?.latestThought).toBe("halfway through the long bit");
  });

  it("does not let a trail write revert the status that follows it", async () => {
    // writeStatus reads the whole map and writes it back, so a trail flush that
    // started before the final write and finished after it would restore the
    // running state over the finished one.
    const { db, board } = fakeDb();

    const agent = agentThatProposes([], {
      propose: async (runCtx: RunContext) => {
        for (let i = 0; i < 8; i += 1) runCtx.log(`line ${i}`);
        return [];
      },
    });

    await runAgent(agent, coordinator() as never, fakeContext({ db }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const entry = board()["content"];
    // The runner logs its own closing line, so that is legitimately last. What
    // must not happen is the finished status being reverted to running, or the
    // trail losing the lines a late flush was carrying.
    expect((entry as { status?: string }).status).toBe("idle");
    expect(entry?.thoughts?.map((t) => t.text)).toContain("line 7");
  });
});

describe("what the trail costs an invocation", () => {
  /** Same fake memory table, but counting every round trip. */
  function countingDb() {
    const rows = new Map<string, unknown>();
    const calls = { reads: 0, writes: 0 };
    return {
      calls,
      db: {
        async readMemory({ keys }: { keys: string[] }) {
          calls.reads += 1;
          const key = keys[0] ?? "";
          return rows.has(key) ? [{ detail: { value: rows.get(key) } }] : [];
        },
        async writeMemory({ key, detail }: { key: string; detail: Record<string, unknown> }) {
          calls.writes += 1;
          rows.set(key, detail["value"]);
        },
      } as unknown as RunContext["db"],
      board: () =>
        (rows.get("runtime.agent_status") ?? {}) as Record<
          string,
          { latestThought?: string; thoughts?: Array<{ text: string }> }
        >,
    };
  }

  /** A run that logs once a minute for ten minutes, in simulated time. */
  async function longRun(db: RunContext["db"]) {
    const agent = agentThatProposes([], {
      propose: async (runCtx: RunContext) => {
        for (let i = 0; i < 10; i += 1) {
          runCtx.log(`minute ${i}`);
          await vi.advanceTimersByTimeAsync(60_000);
        }
        return [];
      },
    });
    await runAgent(agent, coordinator() as never, fakeContext({ db }));
    await vi.advanceTimersByTimeAsync(50);
  }

  it("does not read the board back on every trail write", async () => {
    // This is the property that killed a real run. writeStatus read the map
    // before every write, so each trail line and each heartbeat cost TWO
    // subrequests. Over ten minutes that was about forty, and the invocation
    // hit Cloudflare's per-invocation subrequest ceiling right after composing
    // its brief, losing the approvals it was about to queue. Trail writes now
    // reuse the map this run already holds; only the writes that bracket a run
    // read it back, so whatever else touched the map is still merged.
    vi.useFakeTimers();
    try {
      const { db, calls, board } = countingDb();
      await longRun(db);
      // Three bracketing writes read the board. Ten minutes of trail must not.
      expect(calls.reads).toBeLessThanOrEqual(4);
      // The lines still arrive; this buys round trips back, not visibility.
      expect(board()["content"]?.thoughts?.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a burst of lines down to a handful of writes", async () => {
    // Coalescing plus a floor between writes: fifty lines in a tight loop are
    // one flush, not fifty.
    const { db, calls } = countingDb();
    const agent = agentThatProposes([], {
      propose: async (runCtx: RunContext) => {
        for (let i = 0; i < 50; i += 1) runCtx.log(`line ${i}`);
        return [];
      },
    });
    await runAgent(agent, coordinator() as never, fakeContext({ db }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.writes).toBeLessThanOrEqual(6);
  });
});

describe("rows left behind by a run that never ended", () => {
  function seededDb(seed: Record<string, unknown>) {
    const rows = new Map<string, unknown>(Object.entries(seed));
    return {
      db: {
        async readMemory({ keys }: { keys: string[] }) {
          const key = keys[0] ?? "";
          return rows.has(key) ? [{ detail: { value: rows.get(key) } }] : [];
        },
        async writeMemory({ key, detail }: { key: string; detail: Record<string, unknown> }) {
          rows.set(key, detail["value"]);
        },
      } as unknown as RunContext["db"],
      board: () =>
        (rows.get("runtime.agent_status") ?? {}) as Record<
          string,
          { status?: string; phase?: string; endedAt?: string; error?: string }
        >,
    };
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("closes a row that has claimed to be running for days", async () => {
    // finance_watch was found claiming to be running since three days earlier.
    // writeStatus swallows its own errors on purpose, so a lost terminal write
    // leaves a permanent lie, and the agent that owns the row is not running and
    // cannot correct it. Nothing else was ever going to fix it.
    const { db, board } = seededDb({
      "runtime.agent_status": {
        finance_watch: {
          status: "running",
          phase: "acting",
          runId: "an-older-run",
          startedAt: hoursAgo(72),
        },
      },
    });

    await runAgent(agentThatProposes([]), coordinator() as never, fakeContext({ db }));

    const row = board()["finance_watch"];
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    expect(row?.error).toContain("never recorded an ending");
  });

  it("leaves a genuinely running agent alone", async () => {
    // The bound is the platform's: a cron invocation cannot exceed fifteen
    // minutes, so anything younger than half an hour might still be alive.
    const { db, board } = seededDb({
      "runtime.agent_status": {
        social_engagement: {
          status: "running",
          phase: "thinking",
          runId: "another-run",
          startedAt: hoursAgo(0.1),
          heartbeatAt: hoursAgo(0.02),
        },
      },
    });

    await runAgent(agentThatProposes([]), coordinator() as never, fakeContext({ db }));
    expect(board()["social_engagement"]?.status).toBe("running");
  });

  it("never closes a row belonging to the run doing the sweeping", async () => {
    // Same runId means the same invocation, which is by definition still alive.
    const { db, board } = seededDb({
      "runtime.agent_status": {
        sibling: {
          status: "running",
          phase: "thinking",
          runId: "run-1",
          startedAt: hoursAgo(99),
        },
      },
    });

    // fakeContext uses runId "run-1".
    await runAgent(agentThatProposes([]), coordinator() as never, fakeContext({ db }));
    expect(board()["sibling"]?.status).toBe("running");
  });
});
