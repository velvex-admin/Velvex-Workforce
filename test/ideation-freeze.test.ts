// The ideation freeze: the owner stopped new growth ideas for fourteen days.
//
// "we have more ideas than posts and no way to know which is working and which
// is not" — owner, 2026-09-15. The measurement behind it, over the fortnight
// 2026-08-30 to 2026-09-15: 28 growth ideas approved, 8 posts published. Across
// the whole approvals queue since 2026-08-21: 55 approved growth ideas. No post
// this system has ever made has reported an impression back, so not one of the
// 55 has been scored.
//
// Two halves are asserted here and both matter:
//
//   1. While frozen, NO growth idea leaves a strategist — even when the model
//      returns some anyway, which is the case the prompt alone cannot cover.
//   2. Drafting and publishing are NOT frozen. The owner froze ideation, not
//      the channel, and a freeze that quietly stopped X posting would be a
//      bigger change than the one they asked for.
//
// And the freeze EXPIRES. A test that only proved the freeze works would pass
// forever on a freeze that never lifts, which is the failure this repo has
// already paid for twice: `seo_site` paused past its own stated exit condition,
// `finance_watch` paused since August for a reason nobody recorded.

import { describe, expect, it } from "vitest";
import { IDEATION_FREEZE, ideationFreeze } from "../src/core/ideation.js";
import { xAgent } from "../src/agents/marketing/x.js";
import { planKey, type StoredPlan } from "../src/core/schedule.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { Supabase } from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";

const DURING = new Date("2026-09-20T12:00:00Z");
const AFTER = new Date("2026-10-02T12:00:00Z");

describe("the window itself", () => {
  it("is fourteen days long, which is what was asked for", () => {
    const from = Date.parse(`${IDEATION_FREEZE.from}T00:00:00Z`);
    const until = Date.parse(`${IDEATION_FREEZE.until}T00:00:00Z`);
    expect((until - from) / 86400_000).toBe(14);
  });

  it("is in force on the first day", () => {
    expect(ideationFreeze(new Date(`${IDEATION_FREEZE.from}T00:00:01Z`))).not.toBeNull();
  });

  it("is in force on the last day, and says one day is left", () => {
    const lastDay = new Date(Date.parse(`${IDEATION_FREEZE.until}T00:00:00Z`) - 3600_000);
    expect(ideationFreeze(lastDay)?.daysLeft).toBe(1);
  });

  it("has lifted by the until date, without anyone clearing it", () => {
    // The property that stops this becoming another permanent pause.
    expect(ideationFreeze(new Date(`${IDEATION_FREEZE.until}T00:00:00Z`))).toBeNull();
    expect(ideationFreeze(AFTER)).toBeNull();
  });

  it("was not in force before it was asked for", () => {
    expect(ideationFreeze(new Date("2026-09-14T23:59:59Z"))).toBeNull();
  });

  it("never reports zero days left while it is still on", () => {
    // A prompt reading "0 days left" while refusing ideas is a contradiction
    // the model has to resolve, and it resolves it by proposing.
    for (let day = 0; day < 14; day += 1) {
      const at = new Date(Date.parse(`${IDEATION_FREEZE.from}T09:00:00Z`) + day * 86400_000);
      const freeze = ideationFreeze(at);
      expect(freeze).not.toBeNull();
      expect(freeze!.daysLeft).toBeGreaterThan(0);
    }
  });
});

// --- the strategist, driven for real -------------------------------------

function fakeDb(): Supabase {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async writeMemory(row: { key: string }) {
      rows.set(row.key, row as Record<string, unknown>);
      return row;
    },
    async readMemory(opts: { keys?: string[] } = {}) {
      const key = opts.keys?.[0];
      const row = key ? rows.get(key) : undefined;
      return row ? [row] : [];
    },
    async listReports() {
      return [];
    },
    async listApprovals() {
      return [];
    },
  } as unknown as Supabase;
}

/** What a drafting call returns when the model proposes ideas regardless. */
const RESULT = {
  draft: {
    text: "A distributor can hold every contract and still lose the account, because the renewal clause sits with one buyer.",
    pillar: "diagnostic-method",
    format: "observation",
    reasoning: "Names one mechanism.",
  },
  growth_ideas: [
    { title: "Quote-post public filings", why: "Structural commentary lands.", risk: "low" },
    { title: "Weekly mechanism series", why: "Repeatable shape.", risk: "medium" },
  ],
};

async function runStrategist(now: Date) {
  const db = fakeDb();
  // An empty shelf, so the drafting path is genuinely entered.
  await state.saveContentQueue(db, [] as ContentDraft[]);

  const plan: StoredPlan = { week: "2026-09-14", slots: [], consumed: [] };
  await db.writeMemory({ key: planKey("x"), detail: { value: plan } } as never);

  const logs: string[] = [];
  const ctx = {
    db,
    env: { X_ENABLED: "true" } as unknown as Env,
    now,
    log: (line: string) => logs.push(line),
    claude: {
      complete: async (req: { system: string; user: string }) => ({
        text: JSON.stringify(RESULT),
        json: RESULT,
        parsed: RESULT,
        prompt: `${req.system}\n${req.user}`,
      }),
    },
  } as unknown as RunContext;

  const proposals = await xAgent.propose(ctx);
  return { proposals, logs };
}

describe("a strategist run while ideation is frozen", () => {
  it("proposes no growth idea, even though the model returned two", async () => {
    // The prompt asks for an empty array. This asserts the second line of
    // defence, because a proposal reaching the queue during a freeze looks
    // exactly like a proposal the owner asked for.
    const { proposals } = await runStrategist(DURING);
    expect(proposals.filter((p) => p.type === "campaign_direction")).toHaveLength(0);
  });

  it("says out loud that it dropped them", async () => {
    const { logs } = await runStrategist(DURING);
    expect(logs.join("\n")).toMatch(/dropped 2 growth idea\(s\)/);
    expect(logs.join("\n")).toMatch(new RegExp(IDEATION_FREEZE.until));
  });

  it("still drafts, because drafting was never what was frozen", async () => {
    const { proposals } = await runStrategist(DURING);
    expect(proposals.filter((p) => p.type === "draft_content").length).toBeGreaterThan(0);
  });

  it("tells the model the freeze is on rather than silently discarding its work", async () => {
    // Filtering alone would still pay Opus at effort xhigh to write ideas that
    // are thrown away. The instruction is what makes the freeze cheap.
    let seen = "";
    const db = fakeDb();
    await state.saveContentQueue(db, [] as ContentDraft[]);
    await db.writeMemory({
      key: planKey("x"),
      detail: { value: { week: "2026-09-14", slots: [], consumed: [] } },
    } as never);

    const ctx = {
      db,
      env: { X_ENABLED: "true" } as unknown as Env,
      now: DURING,
      log: () => {},
      claude: {
        complete: async (req: { system: string; user: string }) => {
          seen = `${req.system}\n${req.user}`;
          return { text: JSON.stringify(RESULT), json: RESULT, parsed: RESULT };
        },
      },
    } as unknown as RunContext;

    await xAgent.propose(ctx);
    expect(seen).toMatch(/growth_ideas as an empty array/);
    expect(seen).toMatch(new RegExp(IDEATION_FREEZE.until));
  });
});

describe("a strategist run after the freeze lifts", () => {
  it("proposes growth ideas again with no code change", async () => {
    // The freeze has to end by itself. If this ever goes red because the window
    // was extended, extend this test's date with it rather than deleting it.
    const { proposals } = await runStrategist(AFTER);
    expect(proposals.filter((p) => p.type === "campaign_direction")).toHaveLength(2);
  });

  it("does not tell the model about a freeze that is over", async () => {
    let seen = "";
    const db = fakeDb();
    await state.saveContentQueue(db, [] as ContentDraft[]);
    await db.writeMemory({
      key: planKey("x"),
      detail: { value: { week: "2026-09-28", slots: [], consumed: [] } },
    } as never);

    const ctx = {
      db,
      env: { X_ENABLED: "true" } as unknown as Env,
      now: AFTER,
      log: () => {},
      claude: {
        complete: async (req: { system: string; user: string }) => {
          seen = `${req.system}\n${req.user}`;
          return { text: JSON.stringify(RESULT), json: RESULT, parsed: RESULT };
        },
      },
    } as unknown as RunContext;

    await xAgent.propose(ctx);
    expect(seen).not.toMatch(/growth_ideas as an empty array/);
    expect(seen).toMatch(/zero to three growth ideas/);
  });
});
