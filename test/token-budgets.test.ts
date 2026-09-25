// max_tokens has to cover the thinking, not just the answer.
//
// On this generation thinking is billed inside max_tokens. A budget sized for
// the visible output is therefore spent before the output starts, and what
// comes back is either a truncation or, on a schema'd call, a parse error that
// blames the model for not returning JSON while hiding the real cause. The
// tokens are billed either way.
//
// This was not hypothetical. The SEO agent asked Sonnet 5 at effort "high" for
// a 160-character meta description with max_tokens 400 and failed outright:
// "Ran out of output budget on claude-sonnet-5 (max_tokens 400)". Four more
// calls across the system were sized the same way — social-engagement was
// asking for a reply at effort xhigh with 600 — and would have failed the
// moment they had real work to do.
//
// So this scans the real sources rather than trusting a habit. A small budget
// is legitimate only where the model does no thinking at all.

import { describe, expect, it } from "vitest";
import { SHORT_ANSWER_MAX_TOKENS, XHIGH_WRITER_MAX_TOKENS } from "../src/core/models.js";
import content from "../src/agents/marketing/content.ts?raw";
import { AGENTS } from "../src/agents/registry.js";

import seoSite from "../src/agents/marketing/seo-site.ts?raw";
import objectionFaq from "../src/agents/sales/objection-faq.ts?raw";
import financeWatch from "../src/agents/executive/finance-watch.ts?raw";
import analytics from "../src/agents/marketing/analytics.ts?raw";
import socialEngagement from "../src/agents/marketing/social-engagement.ts?raw";
import competitiveIntel from "../src/agents/intelligence/competitive-intel.ts?raw";
import channelAgent from "../src/agents/marketing/channel-agent.ts?raw";
import growthStrategy from "../src/agents/executive/growth-strategy.ts?raw";
import judge from "../src/lib/judge.ts?raw";
import learningStore from "../src/core/learning-store.ts?raw";

/** Enough for a model to think and then answer briefly. */
const FLOOR = 1500;

const SOURCES: Array<[string, string]> = [
  ["seo-site", seoSite],
  ["objection-faq", objectionFaq],
  ["finance-watch", financeWatch],
  ["analytics", analytics],
  ["social-engagement", socialEngagement],
  ["competitive-intel", competitiveIntel],
  ["channel-agent", channelAgent],
  ["growth-strategy", growthStrategy],
  ["learning-store", learningStore],
];

/**
 * Every max_tokens value in a source that can be resolved to a number.
 *
 * Both forms count. An inline literal is the obvious one, but a call that says
 * `maxTokens: COPY_MAX_TOKENS` is just as undersized if that constant is 400 —
 * and the first version of this test missed exactly that, passing happily on
 * the bug it was written for. A name imported from elsewhere is left alone:
 * the shared constant has its own assertion above.
 */
function numericBudgets(source: string, exempt: Set<string> = new Set()): number[] {
  const locals = new Map<string, number>();
  for (const m of source.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;/g)) {
    locals.set(m[1] as string, Number(m[2]));
  }
  const out: number[] = [];
  for (const m of source.matchAll(/maxTokens:\s*([A-Za-z0-9_]+)/g)) {
    const token = m[1] as string;
    if (exempt.has(token)) continue;
    if (/^\d+$/.test(token)) out.push(Number(token));
    else if (locals.has(token)) out.push(locals.get(token) as number);
  }
  return out;
}

describe("what a thinking model is given room for", () => {
  it("keeps the shared budget big enough to think and then answer", () => {
    expect(SHORT_ANSWER_MAX_TOKENS).toBeGreaterThanOrEqual(FLOOR);
  });

  /**
   * Budgets exempt from the floor, and why.
   *
   * A small budget is only defensible where the model does no thinking. The
   * exemption is by name so it has to be argued for, and the model behind it is
   * asserted separately below — point alt text at a thinking model and the
   * small budget stops being excused.
   */
  const NO_THINKING_BUDGETS = new Set(["ALT_TEXT_MAX_TOKENS"]);

  for (const [name, source] of SOURCES) {
    it(`${name} sizes every budget for thinking as well as output`, () => {
      const undersized = numericBudgets(source, NO_THINKING_BUDGETS).filter((n) => n < FLOOR);
      expect(undersized).toEqual([]);
    });
  }

  it("only exempts the alt-text budget because it runs on the fast tier", () => {
    expect(seoSite).toContain("const ALT_TEXT_MODEL = MODELS.fast");
  });

  it("allows a small budget where the model does no thinking", () => {
    // The judge runs on the fast tier, which takes no thinking parameter at
    // all, so its budget only has to fit the answer. Asserting this keeps the
    // rule honest: it is about thinking, not about big numbers everywhere.
    expect(judge).toContain('modelFor("fast")');
    expect(numericBudgets(judge).some((n) => n < FLOOR)).toBe(true);
  });

  it("still names a budget on every call, rather than leaning on a default", () => {
    // A call with no maxTokens takes the SDK default, which is not sized for
    // anything in particular. Every writing call here should say what it needs.
    for (const [name, source] of SOURCES) {
      // Match the await, not the name: a type annotation like
      // `typeof ctx.claude.complete<ComposedBrief>` is not a call site.
      const calls = (source.match(/await\s+ctx\.claude\.complete/g) ?? []).length;
      const budgets = (source.match(/maxTokens:/g) ?? []).length;
      expect(budgets, `${name}: ${calls} call(s), ${budgets} budget(s)`).toBeGreaterThanOrEqual(
        calls
      );
    }
  });
});

// The same rule one tier up, which is where it bit next.
//
// The floor above asks whether a model has room to think a little and then
// answer. Effort "max" is not a little: the thinking is the entire reason for
// paying for that setting, all of it is billed inside max_tokens, and all of it
// happens before the first token of the answer. So a budget that reads as
// generous beside the answer can still be gone before the answer starts.
//
// Growth-Strategy proved it on 2026-08-30: Opus 5, effort max, max_tokens 4000,
// "Ran out of output budget on claude-opus-5 (max_tokens 4000)". That budget
// cleared the 1500 floor by nearly three times and was still nowhere near
// enough, so the floor alone does not cover this case.
//
// Asserted against the agent roster rather than by pairing efforts with budgets
// in the source text. A regex over adjacent lines would be the clever version
// and it would be worth less: it would pass the day someone moved a comment
// between the two, which is the shape of test this repo has been burned by
// twice already.
describe("what effort max has to be given room for", () => {
  /**
   * Sized for Opus 5.5 at max, which thinks more per turn than Opus 5 did at
   * the same level. 4000 failed on Opus 5; 32000 was the Opus 5 budget.
   */
  const DEEP_FLOOR = 64_000;

  it("names every agent that runs at effort max", () => {
    // Not decoration. A new agent set to max is a new call that can die the way
    // this one did, and the roster is the only place that fact is visible. When
    // this list changes, size that agent's budget on purpose, then change it
    // here. There is deliberately no sibling to copy from: nothing else in the
    // system runs at max.
    // Empty since 2026-09-24, when Growth-Strategy moved to "high". Nothing
    // in the roster runs at max now, so the next agent that does must be
    // sized on purpose rather than inherit a budget.
    const atMax = AGENTS.filter((agent) => agent.effort === "max")
      .map((agent) => agent.id)
      .sort();
    expect(atMax).toEqual([]);
  });

  it("keeps the room Growth-Strategy was given when it ran at max", () => {
    const undersized = numericBudgets(growthStrategy).filter((n) => n < DEEP_FLOOR);
    expect(undersized).toEqual([]);
  });
});

// The public-copy writers run Opus 5.5 at effort xhigh. The X drafting call had
// max_tokens 4000 and died on 2026-09-25 08:00 with "Ran out of output budget on
// claude-opus-5-5 (max_tokens 4000)" once its prompt grew by the shelf list and
// nine lessons. The Content Agent had 2000 at the same effort and was only safe
// because it was paused.
describe("what effort xhigh has to be given room for", () => {
  it("gives the xhigh writers a budget sized for Opus 5.5 thinking", () => {
    expect(XHIGH_WRITER_MAX_TOKENS).toBeGreaterThanOrEqual(16_000);
  });

  it("uses that budget in the strategist's drafting call and in the Content Agent", () => {
    expect(channelAgent).toMatch(/effort: "xhigh",\s*maxTokens: XHIGH_WRITER_MAX_TOKENS/);
    expect(content).not.toMatch(/maxTokens: \d/);
    expect(content.match(/maxTokens: XHIGH_WRITER_MAX_TOKENS/g)?.length).toBe(2);
  });
});
