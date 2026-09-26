// The shelf deadlock: two passes asking different questions about one shelf.
//
// Nothing moves a draft off "ready" — `publishedOn` is the only record that it
// went out — because a channel-neutral draft published on X may still be due on
// LinkedIn. So "is this draft available" is a per-channel question, and both
// passes in `propose()` have to ask it the same way.
//
// They did not. The publish pass filtered on `publishedOn`; the shelf count did
// not. A shelf of three drafts already published on X therefore read as FULL to
// the drafting gate and EMPTY to the publish pass, and the two answers deadlock:
// nothing left to publish, no reason to draft, and the only thing that drains
// the shelf is publishing.
//
// X sat exactly like that from 2026-08-25 to 2026-08-30 — three permanently
// unpublishable drafts, no error anywhere, no publish for five days — and it
// took the learning layer with it, because that lives inside the drafting path.
//
// These tests drive the real xAgent.propose against the shelf as it actually
// was, read out of the live Worker: status "ready", channelHint "x", and a
// publishedOn entry for x on every one.

import { describe, expect, it } from "vitest";
import { xAgent } from "../src/agents/marketing/x.js";
import { planKey, type StoredPlan } from "../src/core/schedule.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
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

const NOW = new Date("2026-08-30T12:00:00Z");
const SLOT = "2026-08-27T20:00:00.000Z"; // in the past, unconsumed — genuinely due

/** A draft on the shelf. `published` mirrors what the live queue held. */
function draft(id: string, published: boolean): ContentDraft {
  return {
    id,
    pillar: "diagnostic-method",
    format: "observation",
    text: `Draft ${id}: a constraint that shows up in three places is one constraint.`,
    createdAt: "2026-08-21T09:00:00Z",
    withinApprovedScope: true,
    channelHint: "x",
    authorAgent: "x",
    publishedOn: published
      ? [{ channel: "x", ref: `20922357452640875${id}`, at: "2026-08-25T13:00:41.301Z" }]
      : [],
    status: "ready",
  };
}

async function propose(drafts: ContentDraft[]) {
  const db = fakeDb();
  await state.saveContentQueue(db, drafts);

  const plan: StoredPlan = {
    week: "2026-08-24",
    slots: [SLOT],
    consumed: [],
  };
  await db.writeMemory({ key: planKey("x"), detail: { value: plan } } as never);

  const logs: string[] = [];
  const ctx = {
    db,
    env: { X_ENABLED: "true" } as unknown as Env,
    now: NOW,
    log: (line: string) => logs.push(line),
    // Drafting is not what these tests are about. Throwing here stops the run
    // at the model call, which propose() catches and logs — so reaching this at
    // all is the observable proof that the shelf gate let it through.
    claude: {
      complete: async () => {
        throw new Error("stubbed: no model in this test");
      },
    },
  } as unknown as RunContext;

  const proposals = await xAgent.propose(ctx);
  return { proposals, logs };
}

describe("a shelf of drafts this channel has already published", () => {
  it("does not count as stock, so the agent still drafts", async () => {
    // Before the fix this logged "3 channel drafts ready, no new draft this
    // run" and returned, on every hourly wake, forever.
    const { logs } = await propose([draft("a", true), draft("b", true), draft("c", true)]);

    expect(logs.join("\n")).not.toMatch(/no new draft this run/);
    expect(logs.join("\n")).toMatch(/drafting call failed/);
  });

  it("produces no publish proposal, because there is nothing left to send", async () => {
    // The other half of the deadlock, and the half that was already correct.
    // Asserting it here is what stops a later "fix" from making the shelf count
    // agree with the publish pass by loosening the publish pass instead —
    // which would republish a post that has already gone out.
    const { proposals } = await propose([draft("a", true), draft("b", true), draft("c", true)]);

    expect(proposals.filter((p) => p.type === "publish_post")).toHaveLength(0);
  });

  it("still holds the gate when the drafts really are unpublished", async () => {
    // The fix must not turn the shelf cap off. Three genuinely available drafts
    // is a full shelf and must still skip the model call.
    const { logs } = await propose([draft("a", false), draft("b", false), draft("c", false)]);

    expect(logs.join("\n")).toMatch(/3 channel drafts ready, no new draft this run/);
    expect(logs.join("\n")).not.toMatch(/drafting call failed/);
  });

  it("publishes the one draft that has not gone out yet", async () => {
    // Mixed shelf: two spent, one available. The available one is what the due
    // slot should take.
    const { proposals } = await propose([draft("a", true), draft("b", true), draft("c", false)]);

    const publish = proposals.filter((p) => p.type === "publish_post");
    expect(publish).toHaveLength(1);
    expect(publish[0]?.payload["draftId"]).toBe("c");
  });
});
