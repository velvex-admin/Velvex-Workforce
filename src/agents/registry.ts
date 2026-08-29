// The roster, and the two things that operate on it: running agents on a tick,
// and carrying out an approval you have granted.

import type { AgentDefinition, RunContext, RunCadence } from "../core/agent.js";
import { runAgent, type AgentRunResult } from "../core/agent.js";
import type { AgentId, AgentBatch } from "../core/types.js";
import {
  overrideIsStale,
  STATE_KEYS,
  state,
  type AgentScheduleMap,
  type AgentScheduleOverride,
} from "../core/state.js";
import type { Supabase } from "../lib/supabase.js";
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
import { siteIntegrityAgent } from "./executive/site-integrity.js";
import { growthStrategyAgent } from "./executive/growth-strategy.js";

import { competitiveIntelAgent } from "./intelligence/competitive-intel.js";

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
  // Executive — four.
  financeWatchAgent,
  opsHealthAgent,
  siteIntegrityAgent,
  // Intelligence — one. Ordered before Growth-Strategy on purpose: both wake on
  // the Monday tick, and Growth-Strategy reads the newest brief when it runs.
  // Registry order is what makes that brief this week's rather than last week's.
  competitiveIntelAgent,
  growthStrategyAgent,
  // Orchestration — one.
  chiefOfStaffAgent,
];

export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

/** Read the dashboard's schedule overrides. Absent when not yet set. */
export async function readSchedules(db: Supabase): Promise<AgentScheduleMap> {
  const value = await state.read<AgentScheduleMap>(db, STATE_KEYS.agentSchedules);
  return value ?? {};
}

/**
 * Which agents are due on this tick, honouring dashboard overrides. An override
 * of "paused" excludes the agent from every cadence; any other override wins
 * over the agent's built-in cadence.
 *
 * The override still wins even when it is stale — see overrideIsStale in
 * core/state.ts. Deciding on an agent's behalf that somebody's pause has
 * expired is not this function's call to make; saying loudly that one has is,
 * and that is what staleOverrides below is for.
 */
export function agentsDueWith(
  cadence: RunCadence,
  overrides: AgentScheduleMap
): AgentDefinition[] {
  return AGENTS.filter((agent) => {
    if (agent.externalBuild) return false;
    if (agent.cadence === "manual" || agent.cadence === "external") return false;

    const override = overrides[agent.id];
    if (override) {
      if (override.cadence === "paused") return false;
      return override.cadence === cadence;
    }

    return agent.cadence === cadence;
  });
}

/**
 * Overrides that were set against a cadence the agent no longer has. Each one
 * is an old decision quietly outranking a newer one, which is invisible unless
 * something goes looking for it. Both live pauses turned out to be this.
 */
export function staleOverrides(
  overrides: AgentScheduleMap
): Array<{ agentId: string; override: AgentScheduleOverride; builtInCadence: string }> {
  const stale: Array<{
    agentId: string;
    override: AgentScheduleOverride;
    builtInCadence: string;
  }> = [];
  for (const agent of AGENTS) {
    const override = overrides[agent.id];
    if (override && overrideIsStale(override, agent.cadence)) {
      stale.push({ agentId: agent.id, override, builtInCadence: agent.cadence });
    }
  }
  return stale;
}

/** Legacy signature. Kept for tests that do not need overrides. */
export function agentsDue(cadence: RunCadence, _now: Date): AgentDefinition[] {
  return agentsDueWith(cadence, {});
}

/**
 * Which slice of a cadence a tick is responsible for.
 *
 * A cron invocation gets fifteen minutes of wall clock for everything it runs,
 * and this loop is sequential. Competitive Intelligence measured 10m03s on its
 * own, which leaves Growth-Strategy — Opus, and the other agent in this system
 * that thinks hard — under five minutes before the whole invocation is killed.
 * The second one would die silently, because a killed agent leaves a "running"
 * row rather than an error. So the weekly cadence is split across two ticks
 * rather than being asked to fit in one.
 */
export interface BatchFilter {
  /** Only these batches. */
  only?: AgentBatch[];
  /** Everything except these batches. */
  except?: AgentBatch[];
}

/** Narrow a list of due agents to the slice one tick owns. */
export function applyBatchFilter(
  agents: AgentDefinition[],
  filter: BatchFilter = {}
): AgentDefinition[] {
  return agents.filter((agent) => {
    if (filter.only && !filter.only.includes(agent.batch)) return false;
    if (filter.except && filter.except.includes(agent.batch)) return false;
    return true;
  });
}

export async function runDue(
  cadence: RunCadence,
  ctx: RunContext,
  filter: BatchFilter = {}
): Promise<AgentRunResult[]> {
  const overrides = await readSchedules(ctx.db).catch(() => ({}));
  for (const entry of staleOverrides(overrides)) {
    ctx.log(
      `${entry.agentId}: schedule override "${entry.override.cadence}" was set when its cadence in code was "${entry.override.builtInCadence}"; it is now "${entry.builtInCadence}". The override is still in force.`
    );
  }
  const results: AgentRunResult[] = [];
  for (const agent of applyBatchFilter(agentsDueWith(cadence, overrides), filter)) {
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
