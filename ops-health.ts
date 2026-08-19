// Ops-Health Agent — Executive. COO-style.
//
// Doc: watches the operations pipeline itself (n8n / Supabase) for error rates
// and stuck cases, separate from and reporting alongside the error-workflow
// monitoring already built into Phase 0.
//
//   Routine        monitoring and reporting
//   Needs approval any infrastructure change
//
// Read-only by construction, and inactive by default. No Phase 0 credentials
// are wired into this project: the agent reads a status endpoint that the
// operations side exposes to it, and until OPS_PIPELINE_STATUS_URL is set it
// reports that it has nothing to watch. It never writes anywhere but its own
// database, and the runner's observe-only guard enforces that.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { flag } from "../../env.js";
import { STATE_KEYS, state } from "../../core/state.js";

export interface OpsStatus {
  collectedAt?: string;
  errorRate?: number;
  failedRuns24h?: number;
  totalRuns24h?: number;
  stuckCases?: Array<{ id: string; stage?: string; stuckForHours?: number }>;
  workflows?: Array<{ name: string; status: string; lastRunAt?: string }>;
}

const ERROR_RATE_WARNING = 0.05;
const STUCK_CASE_WARNING = 3;

export const opsHealthAgent: AgentDefinition = {
  id: "ops_health",
  name: "Ops-Health Agent",
  batch: "executive",
  description:
    "Watches the operations pipeline for error rates and stuck cases, read-only, and reports alongside the Phase 0 error workflow.",
  // No model calls. Error rate against a threshold, stuck cases against a
  // count. Hourly, too, which is exactly where a needless call adds up.
  model: null,
  effort: "medium",
  cadence: "hourly",
  observeOnly: true,
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "ops_health.monitor_and_report",
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
      id: "ops_health.infrastructure_change",
      describe: "Any infrastructure change.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.type === "recommendation" || action.payload["infrastructureChange"] === true
          ? "Infrastructure changes are never this agent's to make. It watches and reports."
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    if (!flag(ctx.env.OPS_PIPELINE_MONITOR_ENABLED) || !ctx.env.OPS_PIPELINE_STATUS_URL) {
      return [
        {
          type: "observation",
          summary: "Ops-Health has nothing to watch: no operations pipeline status endpoint is connected",
          payload: {
            note:
              "Deliberate. No Phase 0 credentials are wired into this project. Point " +
              "OPS_PIPELINE_STATUS_URL at a read-only status endpoint (and set " +
              "OPS_PIPELINE_STATUS_TOKEN if it needs one) to switch this on.",
            active: false,
          },
          dedupeKey: `ops:inactive:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    let status: OpsStatus;
    try {
      const res = await fetch(ctx.env.OPS_PIPELINE_STATUS_URL, {
        method: "GET", // read-only, always
        headers: ctx.env.OPS_PIPELINE_STATUS_TOKEN
          ? { Authorization: `Bearer ${ctx.env.OPS_PIPELINE_STATUS_TOKEN}` }
          : {},
      });
      if (!res.ok) {
        return [
          {
            type: "observation",
            summary: `Operations status endpoint returned ${res.status}`,
            payload: { httpStatus: res.status, active: true },
            dedupeKey: `ops:endpoint-error:${res.status}:${ctx.now.toISOString().slice(0, 13)}`,
          },
        ];
      }
      status = (await res.json()) as OpsStatus;
    } catch (err) {
      return [
        {
          type: "observation",
          summary: "Could not reach the operations status endpoint",
          payload: { error: err instanceof Error ? err.message : String(err) },
          dedupeKey: `ops:unreachable:${ctx.now.toISOString().slice(0, 13)}`,
        },
      ];
    }

    const errorRate = status.errorRate ??
      (status.totalRuns24h ? (status.failedRuns24h ?? 0) / status.totalRuns24h : 0);
    const stuck = status.stuckCases?.length ?? 0;
    const concerning = errorRate >= ERROR_RATE_WARNING || stuck >= STUCK_CASE_WARNING;

    await state.write(ctx.db, STATE_KEYS.opsStatus, status, "latest operations pipeline status", {
      scope: "ops_health",
      agent: "ops_health",
      salience: concerning ? 9 : 5,
      tags: ["ops"],
    });

    return [
      {
        type: "observation",
        summary: concerning
          ? `Operations pipeline needs a look: ${(errorRate * 100).toFixed(1)}% error rate, ${stuck} stuck cases`
          : `Operations pipeline healthy: ${(errorRate * 100).toFixed(1)}% error rate, ${stuck} stuck cases`,
        payload: {
          errorRate,
          stuckCases: stuck,
          failedRuns24h: status.failedRuns24h ?? null,
          totalRuns24h: status.totalRuns24h ?? null,
          concerning,
          detail: status as unknown as Record<string, unknown>,
        },
        dedupeKey: concerning
          ? `ops:concern:${ctx.now.toISOString().slice(0, 13)}`
          : `ops:healthy:${ctx.now.toISOString().slice(0, 10)}`,
      },
    ];
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    await ctx.db.writeMemory({
      key: "ops.latest_read",
      scope: "ops_health",
      kind: "metric",
      content: action.summary,
      detail: action.payload,
      salience: action.payload["concerning"] === true ? 9 : 4,
      source_agent: "ops_health",
      tags: ["ops"],
    });
    return { outcome: "observed", detail: { summary: action.summary } };
  },
};
