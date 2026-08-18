// Agent shape and the run loop every agent goes through.
//
// An agent proposes; the boundary classifies; only then does anything execute.
// No agent module calls a connector directly — that is what keeps the routine /
// needs-approval line from being a comment.

import type { Effort } from "../lib/claude.js";
import { Claude } from "../lib/claude.js";
import type { Supabase } from "../lib/supabase.js";
import type { Env } from "../env.js";
import type {
  AgentBatch,
  AgentId,
  AgentReport,
  AutonomyRule,
  Channel,
  ExecutionResult,
  Judge,
  ProposedAction,
  RuleDecision,
} from "./types.js";
import { evaluate } from "./autonomy.js";

export type Cadence = "hourly" | "daily" | "weekly" | "manual" | "external";

export interface RunContext {
  env: Env;
  db: Supabase;
  claude: Claude;
  judge: Judge;
  runId: string;
  now: Date;
  /** Why this run happened — a cron tick, a manual trigger, an inbound event. */
  trigger: "cron" | "manual" | "event";
  /** Free-form input for event-driven runs (an inbound comment, for instance). */
  input?: Record<string, unknown>;
  log: (message: string, detail?: Record<string, unknown>) => void;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  batch: AgentBatch;
  /** One line, taken from the agent's section in the architecture doc. */
  description: string;

  /** Opus 5 for every agent; effort is the per-agent dial. */
  effort: Effort;
  cadence: Cadence;

  /** Channels this agent may act on. Anything else is a new channel. */
  approvedChannels: Channel[];

  /**
   * True for agents the doc describes as never acting externally. Enforced:
   * an observe-only agent proposing anything other than an observation or a
   * recommendation is stopped by the runner, not trusted to behave.
   */
  observeOnly?: boolean;

  /** Built elsewhere — we expose an integration point, we do not run it. */
  externalBuild?: boolean;

  routineRules: AutonomyRule[];
  approvalRules: AutonomyRule[];

  /** What the agent wants to do this run. */
  propose(ctx: RunContext): Promise<ProposedAction[]>;

  /** Carry out an action that has been classified routine, or approved by you. */
  execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult>;
}

/** What the Chief-of-Staff exposes to every other agent. */
export interface Coordinator {
  /** Routine activity: goes to the reports table. */
  receiveReport(report: AgentReport, ctx: RunContext): Promise<void>;
  /** A new idea or a problem: goes to the approvals queue. */
  escalate(
    args: {
      agent: AgentDefinition;
      action: ProposedAction;
      decision: RuleDecision;
    },
    ctx: RunContext
  ): Promise<{ queued: boolean; approvalId?: string }>;
}

export interface AgentRunResult {
  agentId: AgentId;
  proposed: number;
  executed: number;
  queued: number;
  failed: number;
  decisions: Array<{ action: ProposedAction; decision: RuleDecision; outcome?: string }>;
  error?: string;
}

const OBSERVE_ONLY_TYPES = new Set(["observation", "recommendation", "memory_write", "pipeline_flag"]);

/**
 * Propose -> classify -> execute or queue -> report. The whole autonomy model
 * lives in these forty lines; everything else is detail.
 */
export async function runAgent(
  agent: AgentDefinition,
  coordinator: Coordinator,
  ctx: RunContext
): Promise<AgentRunResult> {
  const result: AgentRunResult = {
    agentId: agent.id,
    proposed: 0,
    executed: 0,
    queued: 0,
    failed: 0,
    decisions: [],
  };

  if (agent.externalBuild) {
    ctx.log(`${agent.id}: external build, nothing to run on our side`);
    return result;
  }

  let actions: ProposedAction[];
  try {
    actions = await agent.propose(ctx);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.failed += 1;
    await coordinator.receiveReport(
      {
        agentId: agent.id,
        batch: agent.batch,
        actionType: "observation",
        summary: `${agent.name} failed while working out what to do`,
        outcome: "failed",
        error: result.error,
      },
      ctx
    );
    return result;
  }

  result.proposed = actions.length;

  for (const action of actions) {
    // An observe-only agent that tries to act externally is a bug, and it is
    // caught here rather than at the connector.
    if (agent.observeOnly && !OBSERVE_ONLY_TYPES.has(action.type)) {
      const decision: RuleDecision = {
        classification: "needs_approval",
        ruleId: `${agent.id}.observe_only_violation`,
        reason: `${agent.name} only observes and reports; it proposed "${action.type}", which acts.`,
        risk: "high",
      };
      const queued = await coordinator.escalate({ agent, action, decision }, ctx);
      result.decisions.push({ action, decision, outcome: queued.queued ? "queued" : "duplicate" });
      result.queued += queued.queued ? 1 : 0;
      continue;
    }

    const decision = await evaluate({
      action,
      approvalRules: agent.approvalRules,
      routineRules: agent.routineRules,
      approvedChannels: agent.approvedChannels,
      ctx: { agentId: agent.id, judge: ctx.judge, now: ctx.now },
    });

    if (decision.classification === "needs_approval") {
      const queued = await coordinator.escalate({ agent, action, decision }, ctx);
      result.decisions.push({ action, decision, outcome: queued.queued ? "queued" : "duplicate" });
      if (queued.queued) result.queued += 1;
      continue;
    }

    try {
      const execution = await agent.execute(action, ctx);
      result.decisions.push({ action, decision, outcome: execution.outcome });
      if (execution.outcome === "failed") result.failed += 1;
      else result.executed += 1;

      await coordinator.receiveReport(
        {
          agentId: agent.id,
          batch: agent.batch,
          actionType: action.type,
          summary: action.summary,
          detail: { ...execution.detail, ruleId: decision.ruleId, ruleReason: decision.reason },
          outcome: execution.outcome,
          channel: action.channel,
          externalRef: execution.externalRef,
          error: execution.error,
        },
        ctx
      );
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      result.decisions.push({ action, decision, outcome: "failed" });
      await coordinator.receiveReport(
        {
          agentId: agent.id,
          batch: agent.batch,
          actionType: action.type,
          summary: action.summary,
          outcome: "failed",
          channel: action.channel,
          error: message,
        },
        ctx
      );
    }
  }

  return result;
}
