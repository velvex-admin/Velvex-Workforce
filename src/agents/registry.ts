// The roster, and the two things that operate on it: running agents on a tick,
// and carrying out an approval you have granted.

import type { AgentDefinition, RunContext } from "../core/agent.js";
import { runAgent, type AgentRunResult } from "../core/agent.js";
import type { AgentId } from "../core/types.js";
import { chiefOfStaff, chiefOfStaffAgent } from "./orchestration/chief-of-staff.js";

import { contentAgent } from "./marketing/content.js";
import { linkedInAgent } from "./marketing/linkedin.js";
import { facebookAgent } from "./marketing/facebook.js";
import { xAgent } from "./marketing/x.js";
import { seoSiteAgent } from "./marketing/seo-site.js";
import { marketingAnalyticsAgent } from "./marketing/analytics.js";
import { socialEngagementAgent } from "./marketing/social-engagement.js";

import { leadPipelineAgent } from "./sales/lead-pipeline.js";
import { objectionFaqAgent } from "./sales/objection-faq.js";

import { financeWatchAgent } from "./executive/finance-watch.js";
import { opsHealthAgent } from "./executive/ops-health.js";
import { growthStrategyAgent } from "./executive/growth-strategy.js";

export const AGENTS: AgentDefinition[] = [
  // Marketing — seven, in the order the doc lists them.
  contentAgent,
  linkedInAgent,
  facebookAgent,
  xAgent,
  seoSiteAgent,
  marketingAnalyticsAgent,
  socialEngagementAgent,
  // Sales management — two.
  leadPipelineAgent,
  objectionFaqAgent,
  // Executive — three.
  financeWatchAgent,
  opsHealthAgent,
  growthStrategyAgent,
  // Orchestration — one.
  chiefOfStaffAgent,
];

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

/** Which agents are due on this tick. */
export function agentsDue(cadence: "hourly" | "daily" | "weekly", now: Date): AgentDefinition[] {
  return AGENTS.filter((agent) => {
    if (agent.externalBuild) return false;
    if (agent.cadence === "manual" || agent.cadence === "external") return false;
    if (cadence === "hourly") return agent.cadence === "hourly";
    if (cadence === "daily") return agent.cadence === "daily";
    return agent.cadence === "weekly";
  }).filter(() => now instanceof Date);
}

export async function runDue(
  cadence: "hourly" | "daily" | "weekly",
  ctx: RunContext
): Promise<AgentRunResult[]> {
  const results: AgentRunResult[] = [];
  for (const agent of agentsDue(cadence, ctx.now)) {
    ctx.log(`running ${agent.id}`);
    results.push(await runAgent(agent, chiefOfStaff, ctx));
  }
  return results;
}

export async function runOne(id: AgentId, ctx: RunContext): Promise<AgentRunResult> {
  const agent = getAgent(id);
  if (!agent) throw new Error(`No agent with id "${id}"`);
  return runAgent(agent, chiefOfStaff, ctx);
}

/**
 * Carrying out something you approved. The stored action is executed verbatim
 * by the agent that proposed it, so what runs is what you reviewed.
 */
export async function executeApproval(
  approvalId: string,
  ctx: RunContext,
  decidedBy = "owner"
): Promise<{ status: string; detail?: Record<string, unknown>; error?: string }> {
  const approval = await ctx.db.getApproval(approvalId);
  if (!approval) return { status: "not_found" };
  if (approval.status !== "approved") {
    return { status: `not_executable:${approval.status}` };
  }

  const agent = getAgent(approval.agent_id);
  if (!agent) {
    await ctx.db.updateApproval(approvalId, {
      status: "failed",
      error: `No agent with id "${approval.agent_id}"`,
    });
    return { status: "failed", error: `No agent with id "${approval.agent_id}"` };
  }

  try {
    const result = await agent.execute(
      { ...approval.action, approvedContentRef: approval.id },
      ctx
    );

    await ctx.db.updateApproval(approvalId, {
      status: result.outcome === "failed" ? "failed" : "executed",
      executed_at: ctx.now.toISOString(),
      execution_result: {
        outcome: result.outcome,
        externalRef: result.externalRef ?? null,
        ...(result.detail ?? {}),
      },
      error: result.error ?? null,
      decided_by: decidedBy,
    });

    await chiefOfStaff.receiveReport(
      {
        agentId: agent.id,
        batch: agent.batch,
        actionType: approval.action.type,
        summary: approval.title,
        detail: { ...result.detail, approvedByOwner: true },
        outcome: result.outcome,
        channel: approval.action.channel,
        externalRef: result.externalRef,
        approvalId,
        error: result.error,
      },
      ctx
    );

    return { status: result.outcome, detail: result.detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db.updateApproval(approvalId, {
      status: "failed",
      executed_at: ctx.now.toISOString(),
      error: message,
    });
    return { status: "failed", error: message };
  }
}
