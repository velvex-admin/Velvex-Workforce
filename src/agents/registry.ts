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
import { readLedger, recordSpend, writeLedger } from "../core/spend.js";
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
  /**
   * Only these agents, by id.
   *
   * A batch is the right unit when a whole batch is expensive, which is what the
   * weekly split needed. It is the wrong unit for the hourly tick: the agent
   * that exhausts it is Site-Integrity, and it shares the `executive` batch with
   * Finance-Watch, Ops-Health and Growth-Strategy, none of which need moving.
   */
  onlyAgents?: AgentId[];
  /** Everything except these agents, by id. */
  exceptAgents?: AgentId[];
}

/** Narrow a list of due agents to the slice one tick owns. */
export function applyBatchFilter(
  agents: AgentDefinition[],
  filter: BatchFilter = {}
): AgentDefinition[] {
  return agents.filter((agent) => {
    if (filter.only && !filter.only.includes(agent.batch)) return false;
    if (filter.except && filter.except.includes(agent.batch)) return false;
    if (filter.onlyAgents && !filter.onlyAgents.includes(agent.id)) return false;
    if (filter.exceptAgents && filter.exceptAgents.includes(agent.id)) return false;
    return true;
  });
}

export async function runDue(
  cadence: RunCadence,
  ctx: RunContext,
  filter: BatchFilter = {}
): Promise<AgentRunResult[]> {
  // Paused has to mean paused, including on the tick where the database blinks.
  //
  // This read used to be `.catch(() => ({}))`, and an empty override map does
  // not mean "no pauses" — it means every agent falls back to its built-in
  // cadence and RUNS. On 2026-09-14 that is exactly what happened: Supabase
  // started answering 504 on the memory table, this read was one of the
  // casualties, and linkedin, facebook, ops_health and social_engagement all
  // woke up and ran on ticks where the owner had paused every one of them. The
  // pauses were still sitting in the database the whole time.
  //
  // That is the worst direction for this failure to go. A pause is the one
  // control the owner has over an agent that spends money, publishes in
  // public, or deploys the site, and a transient database timeout must not be
  // able to lift it. So the tick now fails CLOSED: no override map, no run.
  // Skipping a tick costs one hour; running fifteen agents somebody stopped
  // costs whatever they do. Nothing is thrown, because a throw escaping here
  // kills the whole invocation (section 10), and the Supabase client already
  // retries a read like this before giving up.
  let overrides: AgentScheduleMap;
  try {
    overrides = await readSchedules(ctx.db);
  } catch (err) {
    ctx.log(
      "could not read the schedule overrides, so no agent ran on this tick — " +
        "a pause must not be lifted by a database failure",
      { error: err instanceof Error ? err.message : String(err) }
    );
    return [];
  }
  for (const entry of staleOverrides(overrides)) {
    ctx.log(
      `${entry.agentId}: schedule override "${entry.override.cadence}" was set when its cadence in code was "${entry.override.builtInCadence}"; it is now "${entry.builtInCadence}". The override is still in force.`
    );
  }
  const due = applyBatchFilter(agentsDueWith(cadence, overrides), filter);

  // The weekly cadence used to run on two Monday ticks so that Competitive
  // Intelligence — measured at 10m03s — could not eat Growth-Strategy's share of
  // the fifteen minutes an invocation gets. That split cost a cron line, and
  // Workers Free allows five per account, so it was given up when site_integrity
  // needed one. Intelligence being monthly is what makes that safe, which means
  // its cadence is now load-bearing rather than only a cost choice. Override it
  // back to weekly and the squeeze returns — so say so, rather than letting the
  // second agent be killed with a "running" row and no error, which is exactly
  // how it would present.
  if (cadence === "weekly" && due.length > 1) {
    const heavy = due.filter((agent) => agent.batch === "intelligence");
    if (heavy.length > 0) {
      ctx.log(
        `weekly tick is carrying ${heavy.map((a) => a.id).join(", ")} alongside ${due.length - heavy.length} other agent(s). Intelligence runs ~10 minutes and a cron invocation has 15, so whatever follows it may be killed without an error. Put intelligence back on monthly, or free a cron line for a second weekly tick.`
      );
    }
  }

  const results: AgentRunResult[] = [];
  for (const agent of due) {
    ctx.log(`running ${agent.id}`);
    results.push(await runAgent(agent, chiefOfStaff, ctx));
  }

  // What the tick cost. See recordRunSpend for why it is shared with runOne.
  await recordRunSpend(results, ctx);

  return results;
}

/**
 * Fold what a run spent into the ledger, on the runs that spent something.
 *
 * Shared by the tick and by a single run started by hand, and it is shared
 * because it was not. `runDue` folded and `runOne` did not, so every run
 * started from the dashboard's "Run once" button — which is how an expensive
 * agent gets exercised while it is being fixed, and how the weekly ones get
 * tried without waiting a week — spent real money the ledger never saw. It
 * shows in the data: growth_strategy completed a full Opus run at effort max
 * on 2026-09-05 and that day's ledger entry names only chief_of_staff. So
 * "what does this cost" was answering low, in the one direction that matters
 * when what it feeds is "your credit lasts until February".
 *
 * The write is skipped when nothing was spent. Most hourly ticks make no model
 * call at all — the strategists wake, find their shelves stocked and return —
 * and an invocation has roughly fifty subrequests for everything it runs. This
 * system has already lost an agent to spending them on bookkeeping.
 */
async function recordRunSpend(results: AgentRunResult[], ctx: RunContext): Promise<void> {
  // The number is measured, not modelled: runAgent snapshots the Claude
  // client's spend either side of the run. Before the ledger existed it was
  // computed and thrown away, so "what does this cost to run" had no answer.
  const spending = results
    .filter((r) => r.costUsd > 0)
    .map((r) => ({ agentId: r.agentId, costUsd: r.costUsd, modelCalls: r.modelCalls }));
  if (spending.length === 0) return;

  try {
    const ledger = await readLedger(ctx.db, ctx.now);
    await writeLedger(ctx.db, recordSpend(ledger, spending, ctx.now));
  } catch (err) {
    // Bookkeeping must never take a run down with it. Same rule as the status
    // board and the failure report.
    ctx.log("could not record this run's spend", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runOne(id: AgentId, ctx: RunContext): Promise<AgentRunResult> {
  const agent = getAgent(id);
  if (!agent) throw new Error(`No agent with id "${id}"`);
  const result = await runAgent(agent, chiefOfStaff, ctx);
  await recordRunSpend([result], ctx);
  return result;
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
