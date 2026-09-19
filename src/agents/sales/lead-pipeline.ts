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
import { STATE_KEYS, daysSince, state, type Prospect } from "../../core/state.js";

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
  // No model calls. A stall is a subtraction against the thresholds in config,
  // and the states come from the operations dashboard vocabulary. Paying a
  // model to restate arithmetic would buy nothing.
  model: null,
  effort: "high",
  cadence: "daily",
  approvedChannels: ["internal"],

  // The agent is complete. What is missing is the data, and until this was
  // written down the dashboard had no way to say so: it ran every day, filed
  // "no pipeline data to track", and looked like an agent working fine. An
  // agent with nothing to work on is not the same thing as an agent that works,
  // and it is not a failure either.
  requires: [
    {
      id: "lead_pipeline.pipeline_snapshot",
      summary: "A pipeline snapshot to track. Nothing pushes one yet.",
      // It still runs, and running is what produces the "no data" report that
      // makes the gap visible. Holding it back would hide its own diagnosis.
      blocking: false,
      feed: {
        key: STATE_KEYS.pipeline,
        describe: "there are no prospects to track states or stalls for",
      },
      steps: [
        "Decide what writes the snapshot. The Phase 0 operations pipeline owns the prospect states, so this is a push from there, not a read into it.",
        "POST the snapshot to /x/<APP_PATH_SECRET>/api/state/sales.pipeline as { prospects: [ { id, name?, state, enteredStateAt, lastTouchAt?, value? } ] }.",
        "State names must match the vocabulary in STALL_THRESHOLD_DAYS in src/core/config.ts, or a prospect is counted but never checked for a stall.",
        "Push it on a schedule. A snapshot from three weeks ago produces stalls that are an artefact of the snapshot rather than the pipeline.",
      ],
      note:
        "This agent deliberately does not reach into the operations pipeline's own database. " +
        "Two systems reading one database is how they end up disagreeing about who has been contacted.",
    },
  ],

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
