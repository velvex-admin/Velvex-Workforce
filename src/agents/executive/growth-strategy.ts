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

const SYSTEM = `You are the growth strategist for a small consulting business that sells operational diagnostics. You are the only place where marketing performance and sales pipeline performance are read together.

You are given the last two weeks of agent reports and the standing notes. Propose at most three strategy shifts. For each one:

- Name the shift in a sentence.
- Say what in the data made you propose it. Quote the actual figure. If the data is too thin to support a shift, say that instead of proposing one.
- Say what you would expect to change, and by when.

Nothing you propose happens without the owner approving it, so be direct rather than hedged. No em dashes. No filler.`;

export const growthStrategyAgent: AgentDefinition = {
  id: "growth_strategy",
  name: "Growth-Strategy Agent",
  batch: "executive",
  description:
    "Reads the marketing and sales reports together and proposes strategy shifts. Advisory only: everything it proposes needs approval by definition.",
  effort: "max", // the one agent whose entire output is a judgement call
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

    const window = [...marketing, ...sales].filter((row) => (row.created_at ?? "") >= since);

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

    const analysis = await ctx.claude.complete({
      system: SYSTEM,
      user:
        `Marketing and sales activity, last 14 days (${window.length} entries):\n${activity}\n\n` +
        `Standing notes and figures:\n${notes || "(none)"}`,
      effort: growthStrategyAgent.effort,
      maxTokens: 4000,
    });

    return [
      {
        type: "recommendation",
        summary: `Strategy read, week of ${ctx.now.toISOString().slice(0, 10)}`,
        payload: {
          analysis: analysis.text,
          reportsConsidered: window.length,
          windowDays: 14,
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
