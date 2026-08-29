// The strategist half of the repeated-post failure.
//
// Handing a draft to the LinkedIn partner queue IS this channel's publish step,
// whether or not the partner is switched on yet. The old code only did the
// bookkeeping on the switched-on branch, and the partner is not switched on, so
// every hourly tick found the same ready draft and the same unconsumed slot and
// handed it over again.
//
// These tests drive the real linkedInAgent.execute with the environment as it
// actually is — LINKEDIN_INTEGRATION_ENABLED unset, no partner token — which is
// the input the old tests never constructed.

import { describe, expect, it } from "vitest";
import { linkedInAgent } from "../src/agents/marketing/linkedin.js";
import { collectQueue } from "../src/connectors/linkedin.js";
import { planKey, type StoredPlan } from "../src/core/schedule.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { ProposedAction } from "../src/core/types.js";
import type { Supabase } from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";

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
  } as unknown as Supabase;
}

const NOW = new Date("2026-08-26T15:00:00Z"); // a Wednesday
const SLOT = "2026-08-26T14:00:00.000Z";

async function setup() {
  const db = fakeDb();

  const draft: ContentDraft = {
    id: "draft-1",
    pillar: "diagnostic-method",
    format: "observation",
    text: "A constraint that shows up in three places is one constraint, not three.",
    createdAt: "2026-08-26T09:00:00Z",
    withinApprovedScope: true,
    channelHint: "linkedin",
    authorAgent: "linkedin",
    publishedOn: [],
    status: "ready",
  };
  await state.saveContentQueue(db, [draft]);

  const plan: StoredPlan = {
    week: "2026-08-24",
    slots: [SLOT, "2026-08-27T16:00:00.000Z"],
    consumed: [],
  };
  await db.writeMemory({
    key: planKey("linkedin"),
    detail: { value: plan },
  } as never);

  // The environment as it actually is: the partner has delivered nothing.
  const env = { LINKEDIN_INTEGRATION_ENABLED: "false" } as unknown as Env;
  const ctx = { db, env, now: NOW, log: () => {} } as unknown as RunContext;
  return { db, ctx };
}

const publishAction = (): ProposedAction => ({
  type: "publish_post",
  summary: "Publish to linkedin: ...",
  channel: "linkedin",
  target: "draft-1",
  approvedContentRef: "draft-1",
  payload: {
    draftId: "draft-1",
    text: "A constraint that shows up in three places is one constraint, not three.",
    withinApprovedScope: true,
    pillar: "diagnostic-method",
    format: "observation",
    scheduledSlot: SLOT,
  },
});

async function readPlan(db: Supabase): Promise<StoredPlan> {
  const rows = await db.readMemory({ keys: [planKey("linkedin")], limit: 1 });
  return (rows[0]!.detail as { value: StoredPlan }).value;
}

describe("LinkedIn handover with the partner not yet wired up", () => {
  it("still reports blocked_inactive, because nothing reached LinkedIn", async () => {
    const { ctx } = await setup();
    const result = await linkedInAgent.execute(publishAction(), ctx);
    expect(result.outcome).toBe("blocked_inactive");
    expect(result.detail?.["waitingOn"]).toContain("LINKEDIN_PARTNER_TOKEN");
  });

  it("stamps the draft as handed over, so the next run moves on", async () => {
    const { db, ctx } = await setup();
    await linkedInAgent.execute(publishAction(), ctx);

    const drafts = await state.contentQueue(db);
    expect(drafts[0]!.publishedOn.map((entry) => entry.channel)).toEqual(["linkedin"]);
  });

  it("consumes the slot, so it is not still due an hour later", async () => {
    const { db, ctx } = await setup();
    await linkedInAgent.execute(publishAction(), ctx);
    expect((await readPlan(db)).consumed).toEqual([SLOT]);
  });

  it("does not grow the queue when the same publish is executed twelve times", async () => {
    const { db, ctx } = await setup();
    for (let tick = 0; tick < 12; tick += 1) {
      await linkedInAgent.execute(publishAction(), ctx);
    }
    expect(await collectQueue(db, false)).toHaveLength(1);
  });

  it("stamps the draft exactly once even across repeated executions", async () => {
    const { db, ctx } = await setup();
    await linkedInAgent.execute(publishAction(), ctx);
    await linkedInAgent.execute(publishAction(), ctx);

    const drafts = await state.contentQueue(db);
    // The queue row is the same one both times, so the draft records one
    // handover rather than two to the same place.
    const refs = new Set(drafts[0]!.publishedOn.map((entry) => entry.ref));
    expect(refs.size).toBe(1);
  });

  it("says a repeat handover was a repeat", async () => {
    const { ctx } = await setup();
    await linkedInAgent.execute(publishAction(), ctx);
    const second = await linkedInAgent.execute(publishAction(), ctx);
    expect(second.detail?.["duplicate"]).toBe(true);
  });
});

describe("LinkedIn handover once the partner is wired up", () => {
  it("reports executed, and does the same bookkeeping", async () => {
    const { db } = await setup();
    const env = {
      LINKEDIN_INTEGRATION_ENABLED: "true",
      LINKEDIN_PARTNER_TOKEN: "a-token",
    } as unknown as Env;
    const ctx = { db, env, now: NOW, log: () => {} } as unknown as RunContext;

    const result = await linkedInAgent.execute(publishAction(), ctx);
    expect(result.outcome).toBe("executed");
    expect((await readPlan(db)).consumed).toEqual([SLOT]);
    expect((await state.contentQueue(db))[0]!.publishedOn).toHaveLength(1);
  });
});
