// Closing a growth direction, and recording which direction a post served.
//
// Until 2026-09-24 an approved direction lived for ever: it is written to memory
// at salience 8 tagged [channel, "growth"], the strategist reads its channel's
// tags at minSalience 5 on every draft, and nothing ever lowered one. The owner
// ruled six X directions closed that day and all six were still in the X
// agent's prompt afterwards. And no publish recorded which direction it came
// from, so no direction could ever be scored, whatever signal arrives later.
//
// These tests drive the real xAgent against a fake database that applies the
// same tag and salience filters PostgREST does, because the property that
// matters is "a retired direction does not reach the model", and only a filter
// that behaves like the real one can show that.

import { describe, expect, it } from "vitest";
import { xAgent } from "../src/agents/marketing/x.js";
import channelAgentSource from "../src/agents/marketing/channel-agent.ts?raw";
import {
  RETIRED_SALIENCE,
  RETIRED_TAG,
  STRATEGIST_MIN_SALIENCE,
  retireDirection,
  retiredRow,
  servedDirection,
} from "../src/core/directions.js";
import { planKey, type StoredPlan } from "../src/core/schedule.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { MemoryRow, Supabase } from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const OPEN = "growth.x.2026-09-15.aaaa1111";
const CLOSED = "growth.x.2026-09-16.bbbb2222";

function direction(key: string, title: string): MemoryRow {
  return {
    key,
    scope: "x",
    kind: "decision",
    content: title,
    detail: { title },
    salience: 8,
    source_agent: "x",
    tags: ["x", "growth"],
  };
}

/** A memory table that filters the way PostgREST does for the calls made here. */
function fakeDb(seed: MemoryRow[] = []) {
  const rows = new Map<string, MemoryRow>(seed.map((row) => [row.key, row]));
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
      return out
        .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
        .slice(0, opts.limit ?? 40);
    },
    async listReports() {
      return [];
    },
    async listApprovals() {
      return [];
    },
  };
  return { db: db as unknown as Supabase, rows };
}

async function draftRun(seed: MemoryRow[], claimed: string) {
  const { db } = fakeDb(seed);
  await state.saveContentQueue(db, []);
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
              text: "A price fixed for thirty-six months against an input that reprices every quarter is a bet on the input.",
              pillar: "diagnostic-method",
              format: "observation",
              reasoning: "test",
              direction: claimed,
            },
            growth_ideas: [],
          },
        };
      },
    },
  } as unknown as RunContext;
  const proposals = await xAgent.propose(ctx);
  const drafted = proposals.find((p) => p.type === "draft_content");
  return { drafted, prompt: prompts[0] ?? "" };
}

describe("retiring a direction", () => {
  it("puts it below the strategist's floor and every broadcast reader's", () => {
    const row = retiredRow(direction(CLOSED, "Filing-sourced reads"), NOW.toISOString(), "no web access");

    expect(row.salience).toBe(RETIRED_SALIENCE);
    expect(row.salience!).toBeLessThan(STRATEGIST_MIN_SALIENCE);
    expect(row.salience!).toBeLessThan(6); // Chief-of-Staff and Growth-Strategy
    expect(row.tags).toContain(RETIRED_TAG);
    // History is kept: the row still says what was approved, and why it closed.
    expect(row.content).toBe("Filing-sourced reads");
    expect(row.detail?.["retiredNote"]).toBe("no web access");
    expect(row.detail?.["salienceBeforeRetire"]).toBe(8);
  });

  it("is the floor the strategist actually reads at", () => {
    // The pair is the invariant: retiring below 5 only works while the
    // strategist reads at 5. Assert it reads the shared constant, not a literal
    // somebody could lower on its own.
    expect(channelAgentSource).toMatch(/minSalience:\s*STRATEGIST_MIN_SALIENCE/);
    expect(channelAgentSource).not.toMatch(/minSalience:\s*\d/);
  });

  it("refuses a key that is not a direction, and a direction that does not exist", async () => {
    const { db } = fakeDb([direction(OPEN, "Registers")]);

    const wrong = await retireDirection(db, "site.source", NOW.toISOString());
    expect(wrong).toMatchObject({ ok: false, status: 400 });

    const missing = await retireDirection(db, "growth.x.2026-01-01.nothere", NOW.toISOString());
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  it("is idempotent", async () => {
    const { db, rows } = fakeDb([direction(CLOSED, "Filing-sourced reads")]);
    const first = await retireDirection(db, CLOSED, NOW.toISOString(), "first");
    const second = await retireDirection(db, CLOSED, "2026-09-25T00:00:00Z", "second");

    expect(first).toMatchObject({ ok: true, alreadyRetired: false });
    expect(second).toMatchObject({ ok: true, alreadyRetired: true });
    // The second call must not overwrite the first ruling's date or note.
    expect(rows.get(CLOSED)?.detail?.["retiredNote"]).toBe("first");
  });
});

describe("what the X agent is shown", () => {
  it("hands the model open directions and never retired ones", async () => {
    const seed = [
      direction(OPEN, "Register posts"),
      retiredRow(direction(CLOSED, "Filing-sourced reads"), NOW.toISOString()),
    ];
    const { prompt } = await draftRun(seed, "none");

    expect(prompt).toContain(OPEN);
    expect(prompt).not.toContain(CLOSED);
    expect(prompt).not.toContain("Filing-sourced reads");
  });
});

describe("recording which direction a post served", () => {
  const seed = () => [
    direction(OPEN, "Register posts"),
    retiredRow(direction(CLOSED, "Filing-sourced reads"), NOW.toISOString()),
  ];

  it("keeps an open direction the model names", async () => {
    const { drafted } = await draftRun(seed(), OPEN);
    expect(drafted?.payload["direction"]).toBe(OPEN);
  });

  it("drops a retired, invented or 'none' answer rather than guessing", async () => {
    expect((await draftRun(seed(), CLOSED)).drafted?.payload["direction"]).toBeNull();
    expect((await draftRun(seed(), "growth.x.made-up")).drafted?.payload["direction"]).toBeNull();
    expect((await draftRun(seed(), "none")).drafted?.payload["direction"]).toBeNull();
    expect(servedDirection(undefined, [OPEN])).toBeNull();
  });

  it("stores it on the draft and carries it onto the publish proposal", async () => {
    const { db } = fakeDb();
    await state.saveContentQueue(db, []);
    const ctx = {
      db,
      env: { X_ENABLED: "true" } as unknown as Env,
      now: NOW,
      log: () => {},
    } as unknown as RunContext;

    await xAgent.execute(
      {
        type: "draft_content",
        summary: "draft",
        channel: "internal",
        payload: {
          pillar: "diagnostic-method",
          format: "observation",
          text: "A draft long enough to be a draft, about a term on someone else's clock.",
          channelHint: "x",
          authorAgent: "x",
          voiceClean: true,
          direction: OPEN,
        },
      },
      ctx
    );
    const [stored] = await state.contentQueue(db);
    expect(stored?.direction).toBe(OPEN);

    // Now a due slot: the publish proposal must carry the same direction.
    const slot = "2026-09-23T20:00:00.000Z";
    const plan: StoredPlan = { week: "2026-09-21", slots: [slot], consumed: [] };
    await db.writeMemory({ key: planKey("x"), detail: { value: plan } } as never);
    const proposals = await xAgent.propose({ ...ctx, claude: { complete: async () => { throw new Error("no model"); } } } as unknown as RunContext);
    const publish = proposals.find((p) => p.type === "publish_post");
    expect(publish?.payload["draftId"]).toBe((stored as ContentDraft).id);
    expect(publish?.payload["direction"]).toBe(OPEN);
  });
});
