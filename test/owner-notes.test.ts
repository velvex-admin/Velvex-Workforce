// The owner had been writing to a field with no reader.
//
// `POST /api/approvals/:id/(approve|reject)` stores whatever the owner types in
// the dashboard's note box as `decision_note`. Before this change, exactly ONE
// agent in the system ever read that column back: competitive-intel, and only
// for candidate rejections. Growth-Strategy never did — so every note the owner
// wrote answering a weekly strategy memo went nowhere, and the owner had to ask
// whether it was being read at all.
//
// Two notes were on file when this was written, measured against the live
// Worker on 2026-09-15. The cost is visible in the older one: the agent had
// read fourteen sales entries and reasoned about conversion from them, the
// owner replied "they were only tests not real sales", and the next run read
// the same fourteen rows and could only make the same mistake again.
//
// So the assertions here are about REACH — does the owner's sentence arrive in
// the prompt, and does it arrive ranked above the data it corrects. Asserting
// that the agent "takes account of" a note is not something a test can do; what
// a test can do is prove the note is in front of the model rather than in a
// column nobody selects.

import { describe, expect, it } from "vitest";
import { growthStrategyAgent } from "../src/agents/executive/growth-strategy.js";
import type { RunContext } from "../src/core/agent.js";
import type { Supabase } from "../src/lib/supabase.js";

const NOW = new Date("2026-09-20T09:00:31Z");

/** The two notes that were actually sitting in the live database, abridged. */
const NOTES = [
  {
    id: "1",
    agent_id: "growth_strategy",
    title: "Strategy read, week of 2026-09-13",
    status: "executed",
    created_at: "2026-09-13T09:03:05Z",
    decided_at: "2026-09-15T19:47:22Z",
    decision_note:
      "LinkedIn will be paused for 30 days minimum. For the 14 day freezing I will do it now. " +
      "We have not filled any seats from the first 10 clients offer.",
  },
  {
    id: "2",
    agent_id: "growth_strategy",
    title: "Strategy read, week of 2026-09-04",
    status: "executed",
    created_at: "2026-09-04T06:16:46Z",
    decided_at: "2026-09-05T08:59:16Z",
    decision_note:
      "The only operational channel is X. If you also noticed any sales we have done they were " +
      'only tests not real sales if that is what you meant by "14 of 14 sales entries".',
  },
  {
    id: "3",
    agent_id: "growth_strategy",
    title: "Strategy read, week of 2026-08-23",
    status: "executed",
    created_at: "2026-08-23T08:01:31Z",
    decided_at: "2026-08-23T09:00:00Z",
    decision_note: "",
  },
];

function fakeDb(approvals: unknown[] = NOTES): Supabase {
  return {
    async listReports(opts: { batch?: string } = {}) {
      if (opts.batch !== "marketing") return [];
      return [
        {
          agent_id: "x",
          agent_batch: "marketing",
          summary: "Publish to x: a constraint that shows up in three places",
          outcome: "executed",
          created_at: "2026-09-18T13:00:00Z",
        },
      ];
    },
    async readMemory() {
      return [];
    },
    async listApprovals(_status: string, _limit: number, agentId?: string) {
      // The filter is part of the contract: this agent reads its OWN rulings.
      return approvals.filter(
        (row) => !agentId || (row as { agent_id?: string }).agent_id === agentId
      );
    },
  } as unknown as Supabase;
}

async function run(db: Supabase = fakeDb()) {
  let seen = { system: "", user: "" };
  const logs: string[] = [];
  const ctx = {
    db,
    env: {},
    now: NOW,
    log: (line: string) => logs.push(line),
    claude: {
      complete: async (req: { system: string; user: string }) => {
        seen = { system: req.system, user: req.user };
        return { text: "No shift this week.", json: null };
      },
    },
  } as unknown as RunContext;

  const proposals = await growthStrategyAgent.propose(ctx);
  return { seen, logs, proposals };
}

describe("what the owner wrote reaches the model", () => {
  it("puts the newest note in the prompt, verbatim", async () => {
    const { seen } = await run();
    expect(seen.user).toContain("We have not filled any seats from the first 10 clients offer");
  });

  it("carries the older correction too, so a settled fact stays settled", async () => {
    // This is the one that matters most: without it the agent re-derives
    // "14 sales" from the same rows every week.
    const { seen } = await run();
    expect(seen.user).toContain("only tests not real sales");
  });

  it("dates each note and names what it was ruling on", async () => {
    const { seen } = await run();
    expect(seen.user).toContain("2026-09-15");
    expect(seen.user).toContain("Strategy read, week of 2026-09-13");
  });

  it("puts the owner above the data, not beside it", async () => {
    // Placement is the claim. A note buried under two hundred activity lines
    // is not ranked above them, whatever the system prompt says.
    const { seen } = await run();
    const owner = seen.user.indexOf("What the owner has told you");
    const activity = seen.user.indexOf("Marketing and sales activity");
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(activity).toBeGreaterThan(owner);
    expect(seen.system).toMatch(/outrank the reports/);
  });

  it("skips an empty note rather than showing a blank quote", async () => {
    const { seen } = await run();
    expect(seen.user).not.toMatch(/2026-08-23, ruling on/);
  });

  it("orders them newest first", async () => {
    const { seen } = await run();
    expect(seen.user.indexOf("2026-09-15")).toBeLessThan(seen.user.indexOf("2026-09-05"));
  });

  it("says in the trail that it read them, because that was the question asked", async () => {
    const { logs } = await run();
    expect(logs.join("\n")).toMatch(/read 2 note\(s\) from the owner, newest 2026-09-15/);
  });

  it("records on the proposal how many it had", async () => {
    const { proposals } = await run();
    expect(proposals[0]?.payload?.["ownerNotesRead"]).toBe(2);
  });
});

describe("when there is nothing to read", () => {
  it("says so rather than inventing an instruction", async () => {
    const { seen, logs } = await run(fakeDb([]));
    expect(seen.user).toContain("the owner has not written anything back yet");
    expect(logs.join("\n")).toMatch(/no notes from the owner on file/);
  });

  it("still runs when the approvals read fails outright", async () => {
    // Permissive on purpose, and the direction is argued in the source: the
    // empty value here means "the owner has said nothing", and a strategy memo
    // the owner then declines costs a rejection, not a publish or a dollar.
    const db = {
      ...fakeDb(),
      async listApprovals() {
        throw new Error("504");
      },
    } as unknown as Supabase;
    const { seen, proposals } = await run(db);
    expect(seen.user).toContain("the owner has not written anything back yet");
    expect(proposals).toHaveLength(1);
  });
});

describe("the freeze reaches this agent too", () => {
  it("tells it not to propose new campaigns while ideation is frozen", async () => {
    const { seen } = await run();
    expect(seen.user).toMatch(/NEW GROWTH IDEAS ARE FROZEN until 2026-09-29/);
    expect(seen.user).toMatch(/do not propose new campaigns/);
  });

  it("asks it for the thing that IS useful during a freeze", async () => {
    // A freeze that only says "stop" turns a weekly Opus run into a wasted one.
    const { seen } = await run();
    expect(seen.user).toMatch(/which of them is actually being carried out/);
  });
});
