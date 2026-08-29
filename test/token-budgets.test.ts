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
import { SHORT_ANSWER_MAX_TOKENS } from "../src/core/models.js";

import seoSite from "../src/agents/marketing/seo-site.ts?raw";
import objectionFaq from "../src/agents/sales/objection-faq.ts?raw";
import financeWatch from "../src/agents/executive/finance-watch.ts?raw";
import analytics from "../src/agents/marketing/analytics.ts?raw";
import socialEngagement from "../src/agents/marketing/social-engagement.ts?raw";
import competitiveIntel from "../src/agents/intelligence/competitive-intel.ts?raw";
import channelAgent from "../src/agents/marketing/channel-agent.ts?raw";
import growthStrategy from "../src/agents/executive/growth-strategy.ts?raw";
import judge from "../src/lib/judge.ts?raw";

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
