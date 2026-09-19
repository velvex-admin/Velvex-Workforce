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
import { flag, type Env } from "../../env.js";
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

/**
 * How long to wait for the operations pipeline before giving up on it.
 *
 * This agent runs hourly, near the end of the hourly tick, and reaches a URL on
 * a system this project deliberately holds no control over. A `fetch` with no
 * signal is not a slow call, it is a call that may never return — and the agent
 * that hangs is the one that would have reported the problem. Site-Integrity
 * lost two consecutive ticks to exactly this shape on 2026-08-29, leaving a
 * `running` status row and no error anywhere.
 *
 * Ten seconds is the same budget Site-Integrity gives each page. A status
 * endpoint that cannot answer in ten seconds is itself the news.
 */
const STATUS_FETCH_TIMEOUT_MS = 10_000;

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
  // NOT blocking. Ops-Health has two jobs and only one of them needs the
  // pipeline: it watches this system's own agents regardless, which is the half
  // that matters most while there is no Phase 0 credential to give it.
  requires: [
    {
      id: "ops.pipeline-status-endpoint",
      summary: "The Phase 0 operations pipeline is not being watched — no status endpoint is wired",
      blocking: false,
      steps: [
        "Expose a read-only status endpoint on the operations pipeline. It is a separate project with its own database, and this system deliberately holds no credentials for it, so the pipeline has to offer a URL rather than this agent reaching in.",
        "wrangler secret put OPS_PIPELINE_STATUS_URL, and OPS_PIPELINE_STATUS_TOKEN if it needs one.",
        "Set OPS_PIPELINE_MONITOR_ENABLED = \"true\" in wrangler.toml and deploy.",
      ],
      note:
        "Read-only by design and never to be widened. The hard constraint on this repo is that it does not touch the operations-pipeline project, its database or its infrastructure; a status URL is the whole of the intended coupling.",
      check: (env: Env) =>
        flag(env.OPS_PIPELINE_MONITOR_ENABLED) && env.OPS_PIPELINE_STATUS_URL
          ? null
          : "no OPS_PIPELINE_STATUS_URL is configured",
    },
  ],

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
        signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS),
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
      // Parsed separately from the request, because "the host never answered"
      // and "the host answered with a login page" send you looking in entirely
      // different places, and on a first connection the second is likelier.
      // Reporting both as "could not reach" costs an afternoon.
      const body = await res.text();
      try {
        status = JSON.parse(body) as OpsStatus;
      } catch {
        return [
          {
            type: "observation",
            summary: "Operations status endpoint answered, but not with JSON",
            payload: {
              httpStatus: res.status,
              contentType: res.headers.get("content-type"),
              // Enough to recognise a login page or an error page, not enough
              // to paste somebody's whole dashboard into the memory table.
              bodyStarts: body.slice(0, 200),
              active: true,
            },
            dedupeKey: `ops:not-json:${ctx.now.toISOString().slice(0, 13)}`,
          },
        ];
      }
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return [
        {
          type: "observation",
          summary: timedOut
            ? `Operations status endpoint did not answer within ${STATUS_FETCH_TIMEOUT_MS / 1000}s`
            : "Could not reach the operations status endpoint",
          payload: {
            error: err instanceof Error ? err.message : String(err),
            timedOut,
            active: true,
          },
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
