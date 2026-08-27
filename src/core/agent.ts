// Agent shape and the run loop every agent goes through.
//
// An agent proposes; the boundary classifies; only then does anything execute.
// No agent module calls a connector directly — that is what keeps the routine /
// needs-approval line from being a comment.

import type { Effort } from "../lib/claude.js";
import type { AgentModel } from "./models.js";
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
import { STATE_KEYS, state, type AgentRuntimeStatus, type AgentRuntimeStatusMap } from "./state.js";

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

  /**
   * The model this agent thinks with, chosen for the work it actually does.
   * `null` means it makes no model calls at all: timing, threshold checks and
   * stall arithmetic are deterministic, and an external build is somebody
   * else's cost. See docs/MODEL-CHOICES.md.
   */
  model: AgentModel;
  /** How hard that model thinks. Ignored by models that take no effort setting. */
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

  /**
   * The most this agent may spend in one run, in USD. Unset means uncapped.
   *
   * A ceiling, not a budget: it is there so a run that goes wrong stops instead
   * of continuing to spend. It exists because one did. A research pass paused
   * four times, every resume re-sent the whole accumulated conversation at full
   * input price, and the run cost over three dollars before failing on
   * something unrelated. Nothing noticed, because nothing was counting.
   *
   * Hitting it is a failure, and it reports as one: the agent is told what it
   * spent, and the owner sees it in the queue like any other problem.
   */
  spendCapUsd?: number;

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
  /** What this agent's model calls cost, in USD. Zero for the agents with no model. */
  costUsd: number;
  modelCalls: number;
  decisions: Array<{ action: ProposedAction; decision: RuleDecision; outcome?: string }>;
  error?: string;
}

// What an observe-only agent is still allowed to propose. "intel_brief" is on
// this list because a brief is written into the agent's own library and reaches
// nobody outside the system: it records, it does not act.
const OBSERVE_ONLY_TYPES = new Set([
  "observation",
  "recommendation",
  "memory_write",
  "pipeline_flag",
  "intel_brief",
]);
const MAX_THOUGHTS = 12;

/**
 * Writes the running agent's status board so the dashboard can show what it is
 * doing right now. Errors are swallowed: a status write failing must never
 * take an agent's real work down with it.
 */
async function writeStatus(
  agentId: string,
  patch: Partial<AgentRuntimeStatus>,
  ctx: RunContext
): Promise<void> {
  try {
    const current = (await state.read<AgentRuntimeStatusMap>(ctx.db, STATE_KEYS.agentRuntime)) ?? {};
    const previous = current[agentId] ?? { status: "idle", phase: "idle" };
    const next: AgentRuntimeStatus = { ...previous, ...patch };
    // Only keep the tail of thoughts.
    if (next.thoughts && next.thoughts.length > MAX_THOUGHTS) {
      next.thoughts = next.thoughts.slice(-MAX_THOUGHTS);
    }
    current[agentId] = next;
    await state.write(ctx.db, STATE_KEYS.agentRuntime, current, `runtime status: ${agentId}`, {
      scope: "runtime",
      salience: 1,
      tags: ["runtime"],
    });
  } catch {
    /* ignore */
  }
}

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
    costUsd: 0,
    modelCalls: 0,
    decisions: [],
  };

  // Snapshot spend so this agent's share of the bill is attributable to it.
  const spendBefore = ctx.claude instanceof Claude ? ctx.claude.spentUsd : 0;
  const callsBefore = ctx.claude instanceof Claude ? ctx.claude.callCount : 0;
  const settleSpend = () => {
    if (!(ctx.claude instanceof Claude)) return;
    result.costUsd = Math.round((ctx.claude.spentUsd - spendBefore) * 1_000_000) / 1_000_000;
    result.modelCalls = ctx.claude.callCount - callsBefore;
    // Always lift the ceiling on the way out. The Claude client is shared by
    // every agent on a tick, so leaving one agent's cap in place would starve
    // whichever agent ran next.
    ctx.claude.clearSpendCap();
  };

  if (ctx.claude instanceof Claude && agent.spendCapUsd) {
    ctx.claude.capSpend(agent.spendCapUsd);
  }

  if (agent.externalBuild) {
    ctx.log(`${agent.id}: external build, nothing to run on our side`);
    return result;
  }

  // Live thought capture. Wrap ctx.log so every line the agent emits during
  // this run lands both in the caller's log AND in the status board the
  // dashboard reads. The wrapped ctx is what we hand into propose/execute.
  const thoughts: Array<{ at: string; text: string }> = [];
  const originalLog = ctx.log;
  const runCtx: RunContext = {
    ...ctx,
    log: (message, detail) => {
      const line = detail ? `${message} ${JSON.stringify(detail)}` : message;
      thoughts.push({ at: new Date().toISOString(), text: line });
      // Keep the memory footprint bounded; the last few are all we need.
      if (thoughts.length > MAX_THOUGHTS) thoughts.shift();
      originalLog(message, detail);
    },
  };

  await writeStatus(
    agent.id,
    {
      status: "running",
      phase: "thinking",
      startedAt: ctx.now.toISOString(),
      endedAt: undefined,
      runId: ctx.runId,
      latestThought: `${agent.name} started`,
      thoughts: [{ at: ctx.now.toISOString(), text: `${agent.name} started` }],
      proposed: undefined,
      executed: undefined,
      queued: undefined,
      failed: undefined,
      error: undefined,
    },
    ctx
  );

  let actions: ProposedAction[];
  try {
    actions = await agent.propose(runCtx);
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
      runCtx
    );
    settleSpend();
    await writeStatus(
      agent.id,
      {
        status: "failed",
        phase: "failed",
        endedAt: new Date().toISOString(),
        latestThought: `failed: ${result.error}`,
        thoughts,
        error: result.error,
        proposed: 0,
        executed: 0,
        queued: 0,
        failed: 1,
      },
      ctx
    );
    return result;
  }

  result.proposed = actions.length;
  await writeStatus(
    agent.id,
    {
      phase: "acting",
      latestThought: `proposed ${actions.length} action${actions.length === 1 ? "" : "s"}, deciding what to do with each`,
      thoughts,
    },
    ctx
  );

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
      const queued = await coordinator.escalate({ agent, action, decision }, runCtx);
      result.decisions.push({ action, decision, outcome: queued.queued ? "queued" : "duplicate" });
      result.queued += queued.queued ? 1 : 0;
      continue;
    }

    const decision = await evaluate({
      action,
      approvalRules: agent.approvalRules,
      routineRules: agent.routineRules,
      approvedChannels: agent.approvedChannels,
      ctx: { agentId: agent.id, judge: runCtx.judge, now: runCtx.now },
    });

    if (decision.classification === "needs_approval") {
      const queued = await coordinator.escalate({ agent, action, decision }, runCtx);
      result.decisions.push({ action, decision, outcome: queued.queued ? "queued" : "duplicate" });
      if (queued.queued) result.queued += 1;
      continue;
    }

    try {
      runCtx.log(`executing: ${action.summary}`);
      const execution = await agent.execute(action, runCtx);
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
        runCtx
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
        runCtx
      );
    }
  }

  settleSpend();

  await writeStatus(
    agent.id,
    {
      status: result.failed > 0 && result.executed === 0 && result.queued === 0 ? "failed" : "idle",
      phase: result.failed > 0 && result.executed === 0 && result.queued === 0 ? "failed" : "idle",
      endedAt: new Date().toISOString(),
      latestThought:
        result.proposed === 0
          ? "nothing to do this tick"
          : `${result.executed} executed, ${result.queued} queued, ${result.failed} failed`,
      thoughts,
      proposed: result.proposed,
      executed: result.executed,
      queued: result.queued,
      failed: result.failed,
    },
    ctx
  );

  return result;
}
