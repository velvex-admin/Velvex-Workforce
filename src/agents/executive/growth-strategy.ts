// Growth-Strategy Agent — Executive. CMO-style.
//
// Doc: reads the marketing and sales agents' reports and proposes strategy
// shifts — the one place where marketing and sales performance get looked at
// together instead of separately.
//
//   Routine        advisory only — proposes, never acts
//   Needs approval everything it proposes, by definition
//
// So this agent has an empty routine set on purpose. Every proposal it makes
// goes to the queue, caught by an explicit rule rather than by the default, so
// the reason recorded on each queued item says why rather than "no rule
// matched".

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";

import { MODELS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";
import { STATE_KEYS, state } from "../../core/state.js";

const MODEL = MODELS.reasoning;

const SYSTEM = `You are the growth strategist for Velvex. You are the only place where marketing performance and sales pipeline performance are read together.

${BUSINESS_CONTEXT}

You are given the last two weeks of agent reports, the standing notes, and the newest competitive intelligence brief if there is one. Propose at most three strategy shifts. For each one:

- Name the shift in a sentence.
- Say what in the data made you propose it. Quote the actual figure. If the data is too thin to support a shift, say that instead of proposing one.
- Say what you would expect to change, and by when.

Where a shift is prompted by the intelligence brief rather than by our own numbers, say so, and say which of the two you would trust more if they disagreed. Category movement and our own performance are different kinds of evidence.

Nothing you propose happens without the owner approving it, so be direct rather than hedged. No em dashes. No filler.`;

export const growthStrategyAgent: AgentDefinition = {
  id: "growth_strategy",
  name: "Growth-Strategy Agent",
  batch: "executive",
  description:
    "Reads the marketing and sales reports together and proposes strategy shifts. Advisory only: everything it proposes needs approval by definition.",
  // Weekly, and its entire output is a judgement read across two departments at
  // once. Four calls a month is the cheapest place in the system to buy depth.
  model: MODEL,
  effort: "max",
  cadence: "weekly",
  approvedChannels: ["internal"],

  // Empty by design. See the approval rule below.
  routineRules: [],

  approvalRules: [
    {
      id: "growth_strategy.everything_it_proposes",
      describe: "Everything this agent proposes needs approval, by definition.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) =>
        `Growth-Strategy is advisory: it proposes, it never acts. "${action.type}" goes to you by definition.`,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const since = new Date(ctx.now.getTime() - 14 * 86400_000).toISOString();

    const marketing = await ctx.db.listReports({ batch: "marketing", limit: 120 });
    const sales = await ctx.db.listReports({ batch: "sales_management", limit: 80 });
    const memory = await ctx.db.readMemory({ minSalience: 6, limit: 30 });

    // The newest intelligence brief, as a pointer rather than the document: the
    // whole brief is in intel_briefs and reading it here would put several pages
    // of category research into a prompt that is about our own numbers. The
    // headline and the gaps are what a strategist needs to know it exists.
    const intel = await state
      .read<{ briefDate: string; title: string; headline: string; gaps: string[] }>(
        ctx.db,
        STATE_KEYS.intelLatest
      )
      .catch(() => null);

    const inWindow = (row: { created_at?: string | null }) => (row.created_at ?? "") >= since;
    const marketingWindow = marketing.filter(inWindow);
    const salesWindow = sales.filter(inWindow);
    const window = [...marketingWindow, ...salesWindow];

    if (window.length === 0) {
      return [
        {
          type: "observation",
          summary: "Not enough activity yet to propose a strategy shift",
          payload: {
            note: "Two weeks of marketing and sales reports are needed before this is worth reading.",
          },
          dedupeKey: `growth:thin:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    const activity = window
      .map((row) => `- [${row.agent_id}] ${row.summary} (${row.outcome})`)
      .join("\n");
    const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n");
    const category = intel
      ? `Newest competitive intelligence brief (${intel.briefDate}): ${intel.title}\n${intel.headline}\n` +
        `Positioning gaps it named:\n${(intel.gaps ?? []).map((gap) => `- ${gap}`).join("\n") || "- (none)"}`
      : "(no competitive intelligence brief has been filed yet)";

    // What this read CANNOT see, said out loud.
    //
    // The window is never empty in practice — fifteen agents file reports and
    // most of them are about their own activity — so counting entries answers
    // "did anything happen" and not "is there anything to learn from". This
    // agent's whole premise is reading marketing and sales together, and with
    // sales empty it is reading one department while being told it is reading
    // two. A strategist handed only activity logs will find a pattern in them,
    // because that is what it is for; naming the gap is what lets it decline.
    const blindSpots: string[] = [];
    if (salesWindow.length === 0) {
      blindSpots.push(
        "There are no sales or pipeline reports at all in this window, so nothing below is evidence about conversion, " +
          "lead quality or pipeline movement. Do not infer any of those. This is marketing activity read on its own."
      );
    }
    blindSpots.push(
      "No audience response data exists anywhere in this system yet: the X read endpoints are not on a paid tier and " +
        "LinkedIn analytics need an API review that has not happened. A report saying a post was published is not " +
        "evidence that it was read. Treat published counts as effort, never as performance."
    );

    const analysis = await ctx.claude.complete({
      system: SYSTEM,
      user:
        `Marketing and sales activity, last 14 days (${window.length} entries: ` +
        `${marketingWindow.length} marketing, ${salesWindow.length} sales):\n${activity}\n\n` +
        `What this read cannot see:\n${blindSpots.map((line) => `- ${line}`).join("\n")}\n\n` +
        `Standing notes and figures:\n${notes || "(none)"}\n\n` +
        `Category read:\n${category}`,
      model: MODEL,
      effort: growthStrategyAgent.effort,
      // 4000 failed in production: "Ran out of output budget on claude-opus-5".
      // max_tokens covers THINKING as well as the answer on this generation, and
      // this is Opus reading fourteen days of activity and writing a strategy
      // memo. max_tokens is a ceiling rather than a spend, so raising it costs
      // nothing unless the tokens are generated.
      //
      // 16000 was the repair for that failure and was never proven, because
      // this agent is WEEKLY and has not had a turn since. That is the argument
      // for the larger number rather than against it: one truncation costs a
      // whole week, the largest pass in this system is budgeted at 32000 (the
      // intelligence agent's, at effort "high" since it was measured), and the
      // untaken half of a ceiling is free. Note that this is the ONLY call in
      // the system running at effort "max", so it has no sibling to copy.
      maxTokens: 32000,
    });

    return [
      {
        type: "recommendation",
        summary: `Strategy read, week of ${ctx.now.toISOString().slice(0, 10)}`,
        payload: {
          analysis: analysis.text,
          reportsConsidered: window.length,
          marketingReports: marketingWindow.length,
          salesReports: salesWindow.length,
          windowDays: 14,
          intelBriefDate: intel?.briefDate ?? null,
        },
        rationale: `Read across ${marketing.length} marketing and ${sales.length} sales reports together.`,
        dedupeKey: `growth:${ctx.now.toISOString().slice(0, 10)}`,
      },
    ];
  },

  /**
   * Only ever reached after you approve the recommendation, and even then all
   * it does is record it: acting on a strategy shift is work for the agents
   * that own those channels, under their own rules.
   */
  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    await ctx.db.writeMemory({
      key: `strategy.${ctx.now.toISOString().slice(0, 10)}`,
      scope: "growth_strategy",
      kind: "decision",
      content: action.summary,
      detail: action.payload,
      salience: 9,
      source_agent: "growth_strategy",
      tags: ["strategy"],
    });

    return {
      outcome: "executed",
      detail: {
        note: "Recorded as an approved strategy direction. Carrying it out stays with the agents that own those channels.",
      },
    };
  },
};
