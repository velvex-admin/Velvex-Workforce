// Lead / Pipeline Agent — Sales Management.
//
// Doc: tracks every prospect through the outcome states already defined in the
// operations dashboard (blocked, rejected, pending payment, active analysis,
// concluded, etc.) and flags anything stalled.
//
//   Routine        tracking, flagging stalls, reporting pipeline status
//   Needs approval any direct client-facing action it proposes taking
//
// The states and stall thresholds live in src/core/config.ts. This agent reads
// the pipeline snapshot pushed to /state/sales.pipeline; it does not reach into
// the operations pipeline's own database.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { STALL_THRESHOLD_DAYS } from "../../core/config.js";
import { daysSince, state, type Prospect } from "../../core/state.js";

interface Stall {
  prospect: Prospect;
  days: number;
  threshold: number;
}

const CLIENT_FACING_TYPES = new Set([
  "client_facing_action",
  "reply_public",
  "reply_dm",
  "publish_post",
  "faq_answer",
]);

export const leadPipelineAgent: AgentDefinition = {
  id: "lead_pipeline",
  name: "Lead / Pipeline Agent",
  batch: "sales_management",
  description:
    "Tracks every prospect through the outcome states defined in the operations dashboard and flags anything stalled.",
  effort: "high",
  cadence: "daily",
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "lead_pipeline.track_flag_report",
      describe: "Tracking, flagging stalls, reporting pipeline status.",
      classification: "routine",
      test: (action) =>
        action.type === "pipeline_flag" ||
        action.type === "observation" ||
        action.type === "memory_write"
          ? "Tracking, flagging and reporting are this agent's routine scope."
          : null,
    },
  ],

  approvalRules: [
    {
      id: "lead_pipeline.client_facing_action",
      describe: "Any direct client-facing action it proposes taking.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        CLIENT_FACING_TYPES.has(action.type) || action.payload["clientFacing"] === true
          ? "This would put the agent in front of a prospect. It flags and reports; it does not make contact."
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const snapshot = await state.pipeline(ctx.db);

    if (!snapshot || snapshot.prospects.length === 0) {
      return [
        {
          type: "observation",
          summary: "No pipeline data to track",
          payload: {
            note: "Push a pipeline snapshot to /state/sales.pipeline and this agent will start tracking states and stalls.",
          },
          dedupeKey: "pipeline:no-data",
        },
      ];
    }

    const stalls: Stall[] = [];
    const byState = new Map<string, number>();

    for (const prospect of snapshot.prospects) {
      byState.set(prospect.state, (byState.get(prospect.state) ?? 0) + 1);

      const threshold = STALL_THRESHOLD_DAYS[prospect.state];
      if (threshold === null || threshold === undefined) continue;

      const idle = daysSince(prospect.lastTouchAt ?? prospect.enteredStateAt, ctx.now);
      if (idle >= threshold) stalls.push({ prospect, days: idle, threshold });
    }

    stalls.sort((a, b) => b.days - a.days);

    const proposals: ProposedAction[] = stalls.slice(0, 10).map((stall) => ({
      type: "pipeline_flag" as const,
      summary: `${stall.prospect.name ?? stall.prospect.id} stalled in ${stall.prospect.state} for ${stall.days} days`,
      target: stall.prospect.id,
      payload: {
        prospectId: stall.prospect.id,
        name: stall.prospect.name ?? null,
        pipelineState: stall.prospect.state,
        idleDays: stall.days,
        threshold: stall.threshold,
        value: stall.prospect.value ?? null,
      },
      rationale: `${stall.prospect.state} has a ${stall.threshold} day threshold and this one is at ${stall.days}.`,
      dedupeKey: `stall:${stall.prospect.id}:${stall.prospect.state}:${Math.floor(stall.days / 7)}`,
    }));

    const stateLine = [...byState.entries()]
      .map(([name, count]) => `${name}: ${count}`)
      .join(", ");

    proposals.push({
      type: "observation",
      summary: `Pipeline: ${snapshot.prospects.length} prospects (${stateLine}), ${stalls.length} stalled`,
      payload: {
        total: snapshot.prospects.length,
        byState: Object.fromEntries(byState),
        stalledCount: stalls.length,
        stalled: stalls.slice(0, 10).map((stall) => ({
          id: stall.prospect.id,
          state: stall.prospect.state,
          idleDays: stall.days,
        })),
        snapshotAt: snapshot.updatedAt,
      },
      dedupeKey: `pipeline:status:${ctx.now.toISOString().slice(0, 10)}`,
    });

    return proposals;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type === "pipeline_flag") {
      await ctx.db.writeMemory({
        key: `pipeline.stall.${action.payload["prospectId"]}`,
        scope: "lead_pipeline",
        kind: "pattern",
        content: action.summary,
        detail: action.payload,
        salience: 7,
        source_agent: "lead_pipeline",
        tags: ["pipeline", "stall"],
        // A stall note stops being true once the prospect moves; two weeks is
        // long enough to be useful and short enough not to mislead.
        expires_at: new Date(ctx.now.getTime() + 14 * 86400_000).toISOString(),
      });
      return { outcome: "executed", detail: action.payload };
    }

    if (action.type === "observation") {
      await ctx.db.writeMemory({
        key: "pipeline.status",
        scope: "lead_pipeline",
        kind: "metric",
        content: action.summary,
        detail: action.payload,
        salience: 8,
        source_agent: "lead_pipeline",
        tags: ["pipeline"],
      });
      return { outcome: "observed", detail: action.payload };
    }

    return { outcome: "no_op" };
  },
};
