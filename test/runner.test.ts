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
