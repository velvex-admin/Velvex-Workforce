// The autonomy boundary.
//
// Architecture doc, "Autonomy Boundary — General Rule": routine means anything
// inside an already-approved channel, budget and scope. Needs approval means
// anything new — a new channel, spending money, a pricing or messaging change,
// contacting someone outside the normal flow, or any action that can't be
// undone.
//
// Three properties this implementation holds to:
//
//   1. Approval rules are vetoes. If any fires, the action is queued, no matter
//      what else matched.
//   2. Routine rules are allowances. An action is routine only because a rule
//      says so, never by default.
//   3. Anything unmatched is queued. "Anything new needs approval" only means
//      something if the unknown case lands on the approval side.

import type {
  AutonomyRule,
  ProposedAction,
  RuleContext,
  RuleDecision,
} from "./types.js";

/** Rules that apply to every agent, before its own. */
export function generalRules(approvedChannels: readonly string[]): AutonomyRule[] {
  return [
    {
      id: "general.spend",
      describe: "Spending money is never routine.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        (action.spendMinorUnits ?? 0) > 0
          ? `Action spends ${(action.spendMinorUnits! / 100).toFixed(2)} of budget.`
          : null,
    },
    {
      id: "general.irreversible",
      describe: "Anything that cannot be undone needs a human first.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.reversible === false ? "Action is marked as not reversible." : null,
    },
    {
      id: "general.new_channel",
      describe: "A channel outside the agent's approved set is a new channel.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) =>
        action.channel && !approvedChannels.includes(action.channel)
          ? `Channel "${action.channel}" is outside this agent's approved channels (${approvedChannels.join(", ") || "none"}).`
          : null,
    },
    {
      id: "general.pricing_or_messaging_change",
      describe: "Pricing and positioning changes are yours, not an agent's.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.payload["changesPricing"] === true || action.payload["changesPositioning"] === true
          ? "Action changes pricing or core messaging."
          : null,
    },
    {
      id: "general.outside_normal_flow",
      describe: "Contacting someone outside the normal flow needs approval.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.payload["contactOutsideNormalFlow"] === true
          ? "Action contacts someone outside the established flow."
          : null,
    },
    {
      id: "general.new_by_type",
      describe: "Action types that are new-by-definition: pillars, campaigns, paid promotion.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        (["new_content_pillar", "campaign_direction", "campaign_type", "paid_promotion"] as const).includes(
          action.type as "new_content_pillar" | "campaign_direction" | "campaign_type" | "paid_promotion"
        )
          ? `Action type "${action.type}" is new work by definition.`
          : null,
    },
  ];
}

export interface EvaluateArgs {
  action: ProposedAction;
  approvalRules: AutonomyRule[];
  routineRules: AutonomyRule[];
  approvedChannels: readonly string[];
  ctx: RuleContext;
}

/**
 * Classify one proposed action. Never throws: a rule that blows up (the judge
 * being unreachable, say) resolves to needs_approval, because an agent that
 * cannot tell whether it is allowed to act must not act.
 */
export async function evaluate(args: EvaluateArgs): Promise<RuleDecision> {
  const { action, ctx } = args;
  const vetoes = [...generalRules(args.approvedChannels), ...args.approvalRules];

  for (const rule of vetoes) {
    if (rule.classification !== "needs_approval") continue;
    try {
      const reason = await rule.test(action, ctx);
      if (reason) {
        return {
          classification: "needs_approval",
          ruleId: rule.id,
          reason,
          risk: rule.risk ?? "medium",
        };
      }
    } catch (err) {
      return {
        classification: "needs_approval",
        ruleId: "general.judgement_unavailable",
        reason:
          `Rule "${rule.id}" could not be evaluated (${err instanceof Error ? err.message : String(err)}), ` +
          "so the action is queued rather than taken.",
        risk: "medium",
      };
    }
  }

  for (const rule of args.routineRules) {
    if (rule.classification !== "routine") continue;
    try {
      const reason = await rule.test(action, ctx);
      if (reason) {
        return {
          classification: "routine",
          ruleId: rule.id,
          reason,
          risk: rule.risk ?? "low",
        };
      }
    } catch (err) {
      return {
        classification: "needs_approval",
        ruleId: "general.judgement_unavailable",
        reason:
          `Routine rule "${rule.id}" could not be evaluated (${err instanceof Error ? err.message : String(err)}).`,
        risk: "medium",
      };
    }
  }

  return {
    classification: "needs_approval",
    ruleId: "general.default_deny",
    reason:
      "No routine rule covers this action. Under the general boundary, anything " +
      "not already inside an approved scope counts as new.",
    risk: "medium",
  };
}

/** Convenience for rules that are a plain predicate on the payload. */
export function payloadFlag(
  key: string,
  reason: string
): (action: ProposedAction) => string | null {
  return (action) => (action.payload[key] === true ? reason : null);
}
