// The error path must not need the resource that just ran out.
//
// `runAgent` has two catch blocks whose entire job is to turn a broken run into
// a recorded one. Both filed their report with a bare `await
// coordinator.receiveReport(...)`, and a report is a subrequest — so when the
// thing that broke the run was running OUT of subrequests, the report threw too,
// and that throw escaped `runAgent` completely: past `stopBeat()`, past the
// terminal `writeStatus()`, out of `runDue()`, taking the whole cron invocation
// with it.
//
// The signature that leaves behind is a status row reading "running" forever
// with no error anywhere, which is indistinguishable from an agent still
// thinking. Site-Integrity is last on the hourly tick and the heaviest thing in
// it, and it died exactly this way on consecutive hourly runs on 2026-08-29
// while the same agent, run alone in its own invocation, finished in seconds.
//
// So these tests assert the two things that were not true before: a failing
// report does not escape, and the run still reports its own ending.

import { describe, expect, it } from "vitest";
import { runAgent, type AgentDefinition, type Coordinator, type RunContext } from "../src/core/agent.js";
import { fixedJudge } from "./helpers.js";

function fakeContext(): RunContext {
  return {
    env: {} as RunContext["env"],
    db: {} as RunContext["db"],
    claude: {} as RunContext["claude"],
    judge: fixedJudge("praise"),
    runId: "run-1",
    now: new Date("2026-08-29T21:00:00Z"),
    trigger: "cron",
    log: () => {},
  };
}

/** A coordinator whose every write fails, the way an exhausted budget fails. */
function brokenCoordinator(): Coordinator {
  return {
    receiveReport: async () => {
      throw new Error("Too many subrequests by single Worker invocation");
    },
    escalate: async () => {
      throw new Error("Too many subrequests by single Worker invocation");
    },
  };
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "site_integrity",
    name: "Test Agent",
    batch: "executive",
    description: "test",
    model: null,
    effort: "medium",
    cadence: "hourly",
    approvedChannels: ["internal"],
    routineRules: [
      {
        id: "test.routine",
        describe: "observations are routine",
        classification: "routine",
        test: (action) => (action.type === "observation" ? "routine" : null),
      },
    ],
    approvalRules: [],
    propose: async () => [],
    execute: async () => ({ outcome: "executed" }),
    ...overrides,
  };
}

describe("a failure that cannot be reported", () => {
  it("does not escape runAgent when propose() throws", async () => {
    // Before the fix this rejected with the REPORTING error, not the real one,
    // and the rejection propagated out of runDue and killed the invocation.
    const result = await runAgent(
      agent({
        propose: async () => {
          throw new Error("Too many subrequests by single Worker invocation");
        },
      }),
      brokenCoordinator(),
      fakeContext()
    );

    expect(result.failed).toBe(1);
    // The real cause survives; the reporting failure does not overwrite it.
    expect(result.error).toMatch(/Too many subrequests/);
  });

  it("does not escape runAgent when execute() throws", async () => {
    const result = await runAgent(
      agent({
        propose: async () => [
          { type: "observation", summary: "something worth noting", payload: {} },
        ],
        execute: async () => {
          throw new Error("Too many subrequests by single Worker invocation");
        },
      }),
      brokenCoordinator(),
      fakeContext()
    );

    expect(result.failed).toBe(1);
    expect(result.executed).toBe(0);
  });

  it("does not mark a successful action failed because its report could not be written", async () => {
    // The sharpest case. By the time the success report is written the action
    // has already happened externally. An unguarded throw here used to land in
    // the execute catch, which counted the SAME action as failed on top of the
    // executed it already was — two increments for one action, and a failure
    // report for work that succeeded. An agent reading that back sees something
    // to retry, and retrying an external publish is how the LinkedIn partner
    // queue reached 131 copies of one post.
    const result = await runAgent(
      agent({
        propose: async () => [
          { type: "observation", summary: "something worth noting", payload: {} },
        ],
      }),
      brokenCoordinator(),
      fakeContext()
    );

    expect(result.proposed).toBe(1);
    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
    // One action, one outcome. Never counted twice.
    expect(result.failed + result.executed).toBe(1);
  });
});
