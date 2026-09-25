// The drafting call must see the drafts already waiting on the shelf.
//
// History is what was PUBLISHED. On 2026-09-25 the X shelf held an unpublished
// draft about an HVAC installer whose profit is the manufacturer's volume
// rebate, and the next draft, blind to it, wrote the same mechanism for an
// electrical wholesaler. Both would have gone out back to back. These tests
// drive the real xAgent and assert on the prompt the model is actually given.

import { describe, expect, it } from "vitest";
import { xAgent } from "../src/agents/marketing/x.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { MemoryRow, Supabase } from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";

const NOW = new Date("2026-09-25T06:00:00Z");

function fakeDb() {
  const rows = new Map<string, MemoryRow>();
  const db = {
    async writeMemory(row: MemoryRow) {
      rows.set(row.key, row);
      return row;
    },
    async readMemory(opts: { keys?: string[]; tags?: string[]; minSalience?: number; limit?: number } = {}) {
      let out = [...rows.values()];
      if (opts.keys?.length) out = out.filter((row) => opts.keys!.includes(row.key));
      if (opts.tags?.length) out = out.filter((row) => opts.tags!.every((t) => (row.tags ?? []).includes(t)));
      if (opts.minSalience) out = out.filter((row) => (row.salience ?? 0) >= opts.minSalience!);
      return out.slice(0, opts.limit ?? 40);
    },
    async listReports() {
      return [];
    },
    async listApprovals() {
      return [];
    },
  };
  return db as unknown as Supabase;
}

function draft(id: string, text: string, extra: Partial<ContentDraft> = {}): ContentDraft {
  return {
    id,
    createdAt: "2026-09-24T20:00:00Z",
    pillar: "margin-and-unit-economics",
    format: "short-post",
    text,
    channelHint: "x",
    publishedOn: [],
    status: "ready",
    ...extra,
  } as ContentDraft;
}

async function draftingPrompt(shelf: ContentDraft[]): Promise<string> {
  const db = fakeDb();
  await state.saveContentQueue(db, shelf);
  const prompts: string[] = [];
  const ctx = {
    db,
    env: { X_ENABLED: "true" } as unknown as Env,
    now: NOW,
    log: () => {},
    claude: {
      complete: async (args: { user: string }) => {
        prompts.push(args.user);
        return {
          text: "",
          parsed: {
            draft: {
              text: "A fixed fee against an input that reprices quarterly is a bet on the input.",
              pillar: "margin-and-unit-economics",
              format: "short-post",
              reasoning: "test",
              direction: "none",
            },
            growth_ideas: [],
          },
        };
      },
    },
  } as unknown as RunContext;
  await xAgent.propose(ctx);
  return prompts[0] ?? "";
}

const HVAC =
  "An HVAC installer can price every job at cost and still report profit, because the profit is the manufacturer's volume rebate.";
const PUBLISHED = "Thirty-six month fixed fee against a twelve month vendor licence cycle.";

describe("what the drafting call sees of the shelf", () => {
  it("includes a draft waiting to publish on this channel", async () => {
    const prompt = await draftingPrompt([draft("a", HVAC)]);
    expect(prompt).toContain("Already drafted for x, not yet published");
    expect(prompt).toContain(HVAC);
  });

  it("leaves out drafts already published here and drafts retired", async () => {
    const prompt = await draftingPrompt([
      draft("a", HVAC),
      draft("b", PUBLISHED, { publishedOn: [{ channel: "x", ref: "1", at: "2026-09-22T17:00:00Z" }] }),
      draft("c", "A retired draft about integrations as channels.", { status: "retired" }),
    ]);
    expect(prompt).toContain(HVAC);
    expect(prompt).not.toContain(PUBLISHED);
    expect(prompt).not.toContain("integrations as channels");
  });

  it("says so plainly when the shelf is empty", async () => {
    const prompt = await draftingPrompt([]);
    expect(prompt).toMatch(/not yet published \(these go out before yours\):\n\(none\)/);
  });
});
