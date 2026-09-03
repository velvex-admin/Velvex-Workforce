// What an agent needs before it can work, stated where it will still be found.
//
// Several agents in this system are waiting on things the owner cannot simply
// supply. LinkedIn will not grant the Community Management API without a
// registered legal entity. X's read endpoints need a paid tier. There is no
// Facebook page. Those are not bugs and they will not resolve on their own, and
// an agent in that state presenting as "failed" is worse than useless: a red dot
// that means "LinkedIn wants a registered company" teaches you to stop reading
// red dots.
//
// So a requirement is a first-class thing: it says what is missing, whether the
// agent should be held back entirely or merely runs degraded, and the actual
// steps that would end the wait — written for whoever reads it in six months.

import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/agents/registry.js";
import { isBlocked, runAgent, unmetRequirements, type AgentDefinition } from "../src/core/agent.js";
import { STATE_KEYS } from "../src/core/state.js";
import dashboard from "../src/ui/dashboard.ts?raw";
import api from "../src/routes/api.ts?raw";
import { fixedJudge } from "./helpers.js";
import type { Env } from "../src/env.js";

const BARE = {} as unknown as Env;

function agent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "site_integrity",
    name: "Test",
    batch: "executive",
    description: "test",
    model: null,
    effort: "medium",
    cadence: "hourly",
    approvedChannels: ["internal"],
    routineRules: [],
    approvalRules: [],
    propose: async () => [],
    execute: async () => ({ outcome: "executed" }),
    ...over,
  };
}

const REQ = (over = {}) => ({
  id: "test.thing",
  summary: "A thing is missing",
  blocking: true,
  steps: ["Do the first thing", "Then the second"],
  check: () => "it is missing",
  ...over,
});

describe("the requirement contract", () => {
  it("reports a requirement that is not met", () => {
    const unmet = unmetRequirements(agent({ requires: [REQ()] }), BARE);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toBe("it is missing");
  });

  it("reports nothing when the requirement is satisfied", () => {
    expect(unmetRequirements(agent({ requires: [REQ({ check: () => null })] }), BARE)).toEqual([]);
  });

  it("treats a check that throws as unmet, not as satisfied", () => {
    // Otherwise a broken check silently reads as "everything is fine", which is
    // the one wrong answer this whole mechanism exists to prevent.
    const unmet = unmetRequirements(
      agent({ requires: [REQ({ check: () => { throw new Error("boom"); } })] }),
      BARE
    );
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toMatch(/requirement check failed: boom/);
  });

  it("separates blocking from merely degraded", () => {
    expect(isBlocked(agent({ requires: [REQ({ blocking: false })] }), BARE)).toBe(false);
    expect(isBlocked(agent({ requires: [REQ({ blocking: true })] }), BARE)).toBe(true);
  });
});

describe("a blocked agent", () => {
  const coordinator = {
    receiveReport: async () => {},
    escalate: async () => ({ queued: true }),
  };
  const ctx = () => {
    const logs: string[] = [];
    return {
      logs,
      ctx: {
        env: BARE,
        db: {} as never,
        claude: {} as never,
        judge: fixedJudge("praise"),
        runId: "r1",
        now: new Date("2026-08-31T12:00:00Z"),
        trigger: "cron" as const,
        log: (l: string) => logs.push(l),
      },
    };
  };

  it("does not run, so it cannot spend anything", async () => {
    let proposed = false;
    const { ctx: c } = ctx();
    const result = await runAgent(
      agent({ requires: [REQ()], propose: async () => { proposed = true; return []; } }),
      coordinator as never,
      c as never
    );
    expect(proposed).toBe(false);
    expect(result.proposed).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("says why, rather than going quiet", async () => {
    const { ctx: c, logs } = ctx();
    await runAgent(agent({ requires: [REQ()] }), coordinator as never, c as never);
    expect(logs.join("\n")).toMatch(/blocked, not running.*it is missing/);
  });

  it("still runs when the requirement is only degrading, not blocking", async () => {
    let proposed = false;
    const { ctx: c } = ctx();
    await runAgent(
      agent({
        requires: [REQ({ blocking: false })],
        propose: async () => { proposed = true; return []; },
      }),
      coordinator as never,
      c as never
    );
    expect(proposed).toBe(true);
  });
});

describe("the agents that actually have requirements today", () => {
  const find = (id: string) => AGENTS.find((a) => a.id === id)!;

  it("says LinkedIn is waiting on a registered company, and does not stop it working", () => {
    // NOT blocking is the judgement: the agent drafts in the page's voice,
    // queues every post for approval and learns from the rulings with no API at
    // all. Only delivery is blocked, and approved posts wait in the queue.
    const unmet = unmetRequirements(find("linkedin"), BARE);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.requirement.blocking).toBe(false);
    expect(unmet[0]?.requirement.steps.join(" ")).toMatch(/registered company|legal entity/i);
    expect(unmet[0]?.requirement.steps.join(" ")).toMatch(/LINKEDIN_ACCESS_TOKEN/);
  });

  it("records the org id, so it is not looked up twice", () => {
    // It came off the page's public HTML. Nobody should have to find it again.
    expect(unmetRequirements(find("linkedin"), BARE)[0]?.requirement.steps.join(" ")).toContain(
      "127634091"
    );
  });

  it("blocks Facebook outright, because there is no page to post to", () => {
    const unmet = unmetRequirements(find("facebook"), BARE);
    expect(unmet[0]?.requirement.blocking).toBe(true);
    expect(isBlocked(find("facebook"), BARE)).toBe(true);
  });

  it("says Social Engagement can read nothing yet, without stopping it", () => {
    const unmet = unmetRequirements(find("social_engagement"), BARE);
    expect(unmet[0]?.requirement.blocking).toBe(false);
    expect(unmet[0]?.requirement.steps.join(" ")).toMatch(/402|paid tier/i);
  });

  it("says Ops-Health is not watching the pipeline, and keeps it watching us", () => {
    // It has two jobs. Only one needs the pipeline, and the other is the one
    // that matters while there is no Phase 0 credential to give it.
    const unmet = unmetRequirements(find("ops_health"), BARE);
    expect(unmet[0]?.requirement.blocking).toBe(false);
    expect(unmet[0]?.requirement.steps.join(" ")).toMatch(/OPS_PIPELINE_STATUS_URL/);
  });

  it("gives every requirement steps someone could actually follow", () => {
    for (const a of AGENTS) {
      for (const r of a.requires ?? []) {
        expect(r.steps.length, `${a.id}/${r.id} has no steps`).toBeGreaterThan(0);
        for (const step of r.steps) {
          expect(step.length, `${a.id}/${r.id} has a one-word step`).toBeGreaterThan(30);
        }
        expect(r.summary.length).toBeGreaterThan(15);
      }
    }
  });

  it("leaves every other agent unencumbered", () => {
    // Six now, not four. finance_watch and lead_pipeline joined on 2026-09-03,
    // and they are a different KIND of waiting: the first four are waiting on a
    // credential or a permission, these two are fully configured and waiting on
    // data nobody pushes. Both belong here, because the owner's question is the
    // same either way — "why is this agent not doing anything" — and the answer
    // is a setup step in both cases rather than a repair.
    const withReqs = AGENTS.filter((a) => (a.requires ?? []).length > 0).map((a) => a.id).sort();
    expect(withReqs).toEqual([
      "facebook",
      "finance_watch",
      "lead_pipeline",
      "linkedin",
      "ops_health",
      "social_engagement",
    ]);
  });

  it("declares a feed only where the agent really reads that key", () => {
    // A feed is resolved by reading the key it names. Naming a key nothing
    // writes, or misspelling one, produces a permanent "needs setup" badge that
    // no amount of correct wiring can clear — the failure mode this whole
    // mechanism exists to avoid, reintroduced one level up.
    const declared = AGENTS.flatMap((a) =>
      (a.requires ?? []).flatMap((r) => (r.feed ? [[a.id, r.feed.key] as const] : []))
    );
    expect(declared).toEqual([
      ["lead_pipeline", STATE_KEYS.pipeline],
      ["finance_watch", STATE_KEYS.finance],
    ]);

    // A feed requirement must never be blocking: the agent running is what
    // files the "no data" report that makes the gap visible in the first place.
    for (const a of AGENTS) {
      for (const r of a.requires ?? []) {
        if (r.feed) expect(r.blocking, `${a.id}/${r.id} blocks on a data feed`).toBe(false);
      }
    }
  });
});

describe("it reaches the dashboard", () => {
  it("is served on /api/status per agent, not per run", () => {
    // Per run would vanish the moment a degraded agent had a clean tick, which
    // is exactly when the reminder is easiest to lose.
    //
    // The route resolves feeds as well as environment now, which needs the
    // database — so this asserts the batched resolver rather than the env-only
    // call. The batching is the point: one read for the whole roster, on a
    // route somebody asked for, never a read per agent on a cron tick.
    expect(api).toContain("resolveRequirements(AGENTS, env,");
    expect(api).not.toContain("unmetRequirements(agent, env)");
  });

  it("renders a section naming what is needed", () => {
    expect(dashboard).toContain("What this needs to be operational");
  });

  it("actually interpolates that section into the panel", () => {
    // Asserting the identifier exists is not enough: `const requirementBlock =`
    // survives having the interpolation deleted, so the first version of this
    // test passed on a panel that rendered nothing. Pin the interpolation.
    expect(dashboard).toMatch(/\\\$\{requirementBlock\}/);
  });

  it("shows blocked as amber, never as a failure", () => {
    expect(dashboard).toContain("status-tag blocked");
    expect(dashboard).toContain(".status-tag.blocked{color:var(--amber)}");
    // And a hard block must suppress the red failed styling rather than stack.
    expect(dashboard).toContain("isFailed && !hardBlocked");
  });
});
