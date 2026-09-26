// The engine is spelled Veĺa: the precomposed l-with-acute, U+013A.
//
// A model told the name does not always write the character. On 2026-08-30 a
// LinkedIn growth idea stored "Ve\ru0301la": a broken escape that left a
// carriage return and the text "u0301" where the accent belongs. These tests
// hold the mechanical fix, and drive the real xAgent so the fix is proven on
// the path a post actually takes rather than on the helper alone.

import { describe, expect, it } from "vitest";
import { ENGINE_NAME, fixEngineName, softenTells } from "../src/core/voice.js";
import { BUSINESS, BUSINESS_CONTEXT } from "../src/core/business.js";
import { xAgent } from "../src/agents/marketing/x.js";
import { state, type ContentDraft } from "../src/core/state.js";
import type { RunContext } from "../src/core/agent.js";
import type { MemoryRow, Supabase } from "../src/lib/supabase.js";
import type { Env } from "../src/env.js";

const RIGHT = "Veĺa";

describe("the engine's name", () => {
  it("is one spelling, precomposed, everywhere it is defined", () => {
    expect(ENGINE_NAME).toBe(RIGHT);
    expect(BUSINESS.engine.name).toBe(RIGHT);
    expect(ENGINE_NAME.normalize("NFC")).toBe(ENGINE_NAME);
    expect([...ENGINE_NAME]).toHaveLength(4);
  });

  it("is spelled out for every writing agent, with the character itself", () => {
    expect(BUSINESS_CONTEXT).toContain(`Spell it exactly ${RIGHT}`);
    expect(BUSINESS_CONTEXT).not.toMatch(/\\u013a|&#314;|́/i);
  });
});

describe("fixEngineName", () => {
  const broken = [
    ["the one seen live", "marked Ve\ru0301la v1.0."],
    ["the same, with the escape left as text", "marked Ve\\ru0301la v1.0."],
    ["the accent dropped", "marked Vela v1.0."],
    ["a combining accent after the l", "marked Veĺa v1.0."],
    ["a combining accent written as text", "marked Vel\\u0301a v1.0."],
    ["the letter written as an escape", "marked Ve\\u013aa v1.0."],
    ["the letter as an upper-case escape", "marked Ve\\u013Aa v1.0."],
    ["a decimal HTML entity", "marked Ve&#314;a v1.0."],
    ["a hex HTML entity", "marked Ve&#x13A;a v1.0."],
    ["a named HTML entity", "marked Ve&lacute;a v1.0."],
    ["a spacing acute", "marked Vel´a v1.0."],
  ] as const;

  for (const [name, input] of broken) {
    it(`repairs ${name}`, () => {
      expect(fixEngineName(input)).toBe(`marked ${RIGHT} v1.0.`);
    });
  }

  it("leaves the correct spelling exactly as it was", () => {
    const text = `Every ${RIGHT} v1.0 finding carries a tag. ${RIGHT}'s scoring names six dimensions.`;
    expect(fixEngineName(text)).toBe(text);
  });

  it("repairs every occurrence, not only the first", () => {
    expect(fixEngineName("Vela scores. Ve&#314;a tags.")).toBe(`${RIGHT} scores. ${RIGHT} tags.`);
  });

  it("does not touch words that only contain the letters", () => {
    const text = "Velvex, Venezuela, a novela, velar consonants, Velan, vela and Velas.";
    expect(fixEngineName(text)).toBe(text);
  });

  it("runs inside softenTells, which every writing agent already calls", () => {
    expect(softenTells("Scored by Ve\ru0301la — not guessed.")).toBe(`Scored by ${RIGHT}, not guessed.`);
  });
});

// --- the real X agent ------------------------------------------------------

const NOW = new Date("2026-09-25T06:00:00Z");

function fakeDb() {
  const rows = new Map<string, MemoryRow>();
  const db = {
    async writeMemory(row: MemoryRow) {
      rows.set(row.key, row);
      return row;
    },
    async readMemory(opts: { keys?: string[]; tags?: string[]; limit?: number } = {}) {
      let out = [...rows.values()];
      if (opts.keys?.length) out = out.filter((row) => opts.keys!.includes(row.key));
      if (opts.tags?.length) out = out.filter((row) => opts.tags!.every((t) => (row.tags ?? []).includes(t)));
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

function ctxFor(db: Supabase, parsed: unknown): RunContext {
  return {
    db,
    env: { X_ENABLED: "true" } as unknown as Env,
    now: NOW,
    log: () => {},
    claude: { complete: async () => ({ text: "", parsed }) },
  } as unknown as RunContext;
}

describe("the X agent never hands on a mangled name", () => {
  it("fixes it in the draft it proposes", async () => {
    const db = fakeDb();
    await state.saveContentQueue(db, []);
    const proposals = await xAgent.propose(
      ctxFor(db, {
        draft: {
          text: "Every Ve\ru0301la finding carries one of three tags.",
          pillar: "diagnostic-standard",
          format: "short-post",
          reasoning: "test",
          direction: "none",
        },
        growth_ideas: [],
      })
    );
    const draft = proposals.find((p) => p.type === "draft_content");
    expect(draft?.payload["text"]).toBe(`Every ${RIGHT} finding carries one of three tags.`);
  });

  it("fixes it at publish, for a draft already on the shelf", async () => {
    // A draft written before the check existed must not go out as it was stored.
    const db = fakeDb();
    const shelf: ContentDraft = {
      id: "old",
      createdAt: "2026-09-23T07:00:00Z",
      pillar: "diagnostic-standard",
      format: "short-post",
      text: "Scored by Veĺa v1.0.",
      channelHint: "x",
      publishedOn: [],
      status: "ready",
      withinApprovedScope: true,
    } as ContentDraft;
    await state.saveContentQueue(db, [shelf]);
    const sent: string[] = [];
    const ctx = ctxFor(db, null);
    const action = {
      type: "publish_post" as const,
      summary: "publish",
      channel: "x" as const,
      target: "old",
      payload: { text: shelf.text, draftId: "old" },
      rationale: "test",
    };
    // Stub the one outbound call so the test sees exactly what would be posted.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const env = {
        X_ENABLED: "true",
        X_API_KEY: "k",
        X_API_SECRET: "s",
        X_ACCESS_TOKEN: "t",
        X_ACCESS_TOKEN_SECRET: "ts",
      } as unknown as Env;
      await xAgent.execute(action as never, { ...ctx, env } as RunContext);
    } finally {
      globalThis.fetch = realFetch;
    }
    const tweet = sent.find((body) => body.includes("Scored by"));
    expect(tweet).toBeDefined();
    expect(JSON.parse(tweet!).text).toBe(`Scored by ${RIGHT} v1.0.`);
  });

  it("fixes it in growth ideas, which later drafts are handed as open work", async () => {
    const db = fakeDb();
    await state.saveContentQueue(db, []);
    const later = new Date("2026-10-05T06:00:00Z"); // after the ideation freeze
    const proposals = await xAgent.propose({
      ...ctxFor(db, {
        draft: {
          text: "A plain draft.",
          pillar: "diagnostic-standard",
          format: "short-post",
          reasoning: "test",
          direction: "none",
        },
        growth_ideas: [
          { title: "Pin a Vela v1.0 reference", why: "Ve&#314;a tags are the proof.", risk: "low" },
        ],
      }),
      now: later,
    } as RunContext);
    const idea = proposals.find((p) => p.type === "campaign_direction");
    expect(idea?.payload["title"]).toBe(`Pin a ${RIGHT} v1.0 reference`);
    expect(idea?.payload["why"]).toBe(`${RIGHT} tags are the proof.`);
  });
});
