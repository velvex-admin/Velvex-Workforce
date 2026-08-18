// Finance-Watch Agent — Executive. CFO-style.
//
// Doc: tracks margins, PayPal flow, and cost-per-client against
// revenue-per-client as volume grows — this is the profit guardrail: it flags
// the moment that ratio turns unsustainable rather than after the fact.
//
//   Routine        monitoring and reporting
//   Needs approval any recommendation to change pricing or pause spend
//
// The guardrail is arithmetic, not vibes: thresholds live in FINANCE_GUARDRAIL
// and are checked before the model is asked for anything. PayPal itself is a
// live Phase 0 integration and is deliberately not re-connected here; figures
// arrive as a snapshot pushed to /state/finance.snapshot.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { FINANCE_GUARDRAIL } from "../../core/config.js";
import { state, type FinanceSnapshot } from "../../core/state.js";

interface Ratios {
  revenuePerClientMinor: number;
  costPerClientMinor: number;
  costRatio: number;
  margin: number;
  totalCostMinor: number;
}

function ratios(snapshot: FinanceSnapshot): Ratios | null {
  if (snapshot.clientsServed <= 0 || snapshot.revenueMinor <= 0) return null;

  const totalCostMinor =
    snapshot.directCostMinor + (snapshot.toolingCostMinor ?? 0) + (snapshot.paypalFeesMinor ?? 0);

  return {
    revenuePerClientMinor: snapshot.revenueMinor / snapshot.clientsServed,
    costPerClientMinor: totalCostMinor / snapshot.clientsServed,
    costRatio: totalCostMinor / snapshot.revenueMinor,
    margin: (snapshot.revenueMinor - totalCostMinor) / snapshot.revenueMinor,
    totalCostMinor,
  };
}

const money = (minor: number) => `${(minor / 100).toFixed(2)}`;

export const financeWatchAgent: AgentDefinition = {
  id: "finance_watch",
  name: "Finance-Watch Agent",
  batch: "executive",
  description:
    "Tracks margin and cost-per-client against revenue-per-client as volume grows, and flags the moment the ratio turns unsustainable.",
  effort: "high",
  cadence: "daily",
  observeOnly: true,
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "finance_watch.monitor_and_report",
      describe: "Monitoring and reporting.",
      classification: "routine",
      test: (action) =>
        action.type === "observation" || action.type === "memory_write"
          ? "Monitoring and reporting is this agent's routine scope."
          : null,
    },
  ],

  approvalRules: [
    {
      id: "finance_watch.pricing_or_spend_recommendation",
      describe: "Any recommendation to change pricing or pause spend.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.type === "recommendation" ||
        action.payload["changesPricing"] === true ||
        action.payload["pausesSpend"] === true
          ? "A recommendation to change pricing or pause spend is a decision, and decisions are yours."
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const snapshot = await state.finance(ctx.db);

    if (!snapshot) {
      return [
        {
          type: "observation",
          summary: "No finance snapshot to watch",
          payload: {
            note: "Push revenue, cost and client counts to /state/finance.snapshot and the guardrail starts working.",
          },
          dedupeKey: "finance:no-data",
        },
      ];
    }

    const computed = ratios(snapshot);
    if (!computed) {
      return [
        {
          type: "observation",
          summary: "Finance snapshot has no clients or no revenue in it, so there is no ratio to watch yet",
          payload: { snapshot: snapshot as unknown as Record<string, unknown> },
          dedupeKey: `finance:empty:${snapshot.periodEnd}`,
        },
      ];
    }

    const breached =
      computed.costRatio >= FINANCE_GUARDRAIL.costRatioCritical ||
      computed.margin < FINANCE_GUARDRAIL.marginFloor;
    const warning = computed.costRatio >= FINANCE_GUARDRAIL.costRatioWarning;

    const figures =
      `Period ${snapshot.periodStart} to ${snapshot.periodEnd}\n` +
      `Revenue ${money(snapshot.revenueMinor)} across ${snapshot.clientsServed} clients\n` +
      `Revenue per client ${money(computed.revenuePerClientMinor)}\n` +
      `Cost per client ${money(computed.costPerClientMinor)}\n` +
      `Cost as a share of revenue ${(computed.costRatio * 100).toFixed(1)}%\n` +
      `Margin ${(computed.margin * 100).toFixed(1)}% (floor ${(FINANCE_GUARDRAIL.marginFloor * 100).toFixed(0)}%)`;

    const proposals: ProposedAction[] = [];

    const read = await ctx.claude.complete({
      system:
        "You are the finance watch for a small consulting business. You are given real figures. " +
        "Say what they mean for whether this stays profitable as volume grows. Use only the numbers " +
        "given. Three sentences at most, no em dashes, no hedging padding.",
      user: figures,
      effort: financeWatchAgent.effort,
      maxTokens: 700,
    });

    proposals.push({
      type: "observation",
      summary: breached
        ? `GUARDRAIL BREACHED: cost is ${(computed.costRatio * 100).toFixed(1)}% of revenue, margin ${(computed.margin * 100).toFixed(1)}%`
        : `Margin ${(computed.margin * 100).toFixed(1)}%, cost ${(computed.costRatio * 100).toFixed(1)}% of revenue`,
      payload: {
        ...computed,
        breached,
        warning,
        periodStart: snapshot.periodStart,
        periodEnd: snapshot.periodEnd,
        read: read.text,
      },
      dedupeKey: `finance:read:${snapshot.periodEnd}`,
    });

    // The guardrail firing is the one thing this agent escalates. It is a
    // recommendation, so it goes to the queue by its own rule rather than being
    // logged and lost among routine reports.
    if (breached) {
      proposals.push({
        type: "recommendation",
        summary: `Profit guardrail breached for ${snapshot.periodStart} to ${snapshot.periodEnd}`,
        payload: {
          ...computed,
          changesPricing: true,
          thresholds: FINANCE_GUARDRAIL,
          read: read.text,
        },
        rationale:
          `Cost per client is ${money(computed.costPerClientMinor)} against revenue per client of ` +
          `${money(computed.revenuePerClientMinor)}. That is ${(computed.costRatio * 100).toFixed(1)}% of revenue, ` +
          `past the ${(FINANCE_GUARDRAIL.costRatioCritical * 100).toFixed(0)}% line. This is the ratio turning ` +
          `unsustainable, flagged now rather than after the fact.`,
        dedupeKey: `finance:breach:${snapshot.periodEnd}`,
      });
    }

    return proposals;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    await ctx.db.writeMemory({
      key: "finance.latest_read",
      scope: "finance_watch",
      kind: "metric",
      content: action.summary,
      detail: action.payload,
      salience: action.payload["breached"] === true ? 10 : 8,
      source_agent: "finance_watch",
      tags: ["finance"],
    });
    return { outcome: "observed", detail: { summary: action.summary } };
  },
};
