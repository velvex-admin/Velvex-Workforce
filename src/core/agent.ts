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

/**
 * Cadences a cron tick can be responsible for.
 *
 * "monthly" exists because a category with few competitors does not move weekly.
 * A brief written every week about a market that shifts quarterly is how a
 * library stops being read, and it is paid for either way.
 */
export type RunCadence = "hourly" | "daily" | "weekly" | "monthly";
export type Cadence = RunCadence | "manual" | "external";

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
  // A restore is on this list and it is worth being precise about why, because
  // it is the only entry that touches the outside world. The guarantee this
  // flag makes is narrower than "never writes": it is "never writes anything
  // NEW". A restore publishes bytes that were already checked and found sound,
  // and its payload is not model-generated — no agent on this list can author
  // a page. Site-Integrity is the only agent that may propose one, by rule.
  "site_restore",
]);
const MAX_THOUGHTS = 12;
/** How often a running agent proves it is still alive. */
const HEARTBEAT_MS = 120_000;
/** Floor between two trail writes, however chatty the agent gets. */
const TRAIL_MIN_GAP_MS = 15_000;

/**
 * Writes the running agent's status board so the dashboard can show what it is
 * doing right now. Errors are swallowed: a status write failing must never
 * take an agent's real work down with it.
 *
 * A Worker gets a fixed number of subrequests per invocation, and the read here
 * costs one of them just as the write does. That is affordable for the handful
 * of status writes around a run and it is NOT affordable for a trail: a
 * ten-minute run with a heartbeat and a flush per log line spent roughly forty
 * subrequests on this function alone and died on the limit after composing its
 * brief, losing the approvals it was about to queue. So the read is optional.
 * Pass a cached map and the call costs one subrequest instead of two.
 */
async function writeStatus(
  agentId: string,
  patch: Partial<AgentRuntimeStatus>,
  ctx: RunContext,
  cached?: AgentRuntimeStatusMap
): Promise<AgentRuntimeStatusMap | null> {
  try {
    const fresh = cached ?? (await state.read<AgentRuntimeStatusMap>(ctx.db, STATE_KEYS.agentRuntime));
    const current = fresh ?? {};

    // Only on a read. A trail write reuses a map this run already swept, and
    // sweeping it again would cost nothing and prove nothing.
    if (!cached) {
      const closed = reconcileStale(current, ctx.runId, Date.now());
      if (closed > 0) {
        ctx.log(`runtime: closed ${closed} stale status row(s) left by a run that never ended`);
      }
    }
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
    return current;
  } catch {
    /* ignore */
    return null;
  }
}

/**
 * How long a row may claim to be running before it is provably lying.
 *
 * A cron invocation is capped at fifteen minutes of wall clock by the platform,
 * so nothing started by an earlier invocation can still be running half an hour
 * later. This is not a guess about slowness; it is an upper bound.
 */
const IMPOSSIBLE_RUN_MS = 30 * 60 * 1000;

/**
 * Close out rows left claiming to be running by a run that is gone.
 *
 * writeStatus swallows its own errors, deliberately: a status write must never
 * take an agent's real work down with it. The cost is that a LOST terminal
 * write leaves a permanent lie. Three rows were found in exactly that state —
 * finance_watch had been "running" for three days, and marketing_analytics was
 * mid-tick alongside a Chief-of-Staff row that had finished, which proves the
 * agent itself completed and only its ending went missing.
 *
 * Nothing else was ever going to fix those: the agent that owns the row is not
 * running, so it cannot correct itself. So every run sweeps the board on its way
 * in, using the one fact that makes it safe — a different runId plus an age no
 * invocation is allowed to reach.
 */
function reconcileStale(board: AgentRuntimeStatusMap, runId: string, now: number): number {
  let closed = 0;
  for (const [id, row] of Object.entries(board)) {
    if (!row || row.status !== "running" || row.runId === runId) continue;
    const seen = Date.parse(row.heartbeatAt ?? row.startedAt ?? "");
    if (!Number.isFinite(seen) || now - seen < IMPOSSIBLE_RUN_MS) continue;
    board[id] = {
      ...row,
      status: "failed",
      phase: "failed",
      endedAt: new Date(now).toISOString(),
      error:
        row.error ??
        "This run stopped reporting and never recorded an ending. Closed by a later run.",
    };
    closed += 1;
  }
  return closed;
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

  // The trail has to reach the board WHILE the agent is working, not after.
  // Collecting lines into an array and only writing them around propose() made
  // the trail live for agents that finish in seconds and useless for the one
  // agent that does not: Competitive Intelligence spends its whole run inside
  // propose(), so the board sat on "started" for ten minutes and the dashboard
  // could not distinguish that from a hang.
  //
  // Three properties this needs, and none of them are optional. It cannot be
  // awaited, because ctx.log is synchronous and called from inside the agent's
  // own work. Two writes must not interleave, because writeStatus reads the
  // whole status map and writes it back, so an older read landing after a newer
  // write silently reverts it. And a chatty agent must not buy one round trip
  // per line, so a flush already in flight sets a flag rather than queueing.
  let flushing = false;
  let flushAgain = false;
  let flushChain: Promise<void> = Promise.resolve();
  let lastFlushAt = 0;
  // The board as this run last left it. Held so a trail write can skip the read
  // and cost one subrequest instead of two; the terminal writes still read, so
  // whatever else touched the map is merged back before the run signs off.
  let board: AgentRuntimeStatusMap | null = null;
  const flushThoughts = (): void => {
    if (flushing) {
      flushAgain = true;
      return;
    }
    // A trail line is worth a subrequest, but not every line and not on demand.
    // Ten minutes of unthrottled flushing is what exhausted the invocation's
    // subrequest budget and cost a run its approvals queue.
    if (Date.now() - lastFlushAt < TRAIL_MIN_GAP_MS) {
      flushAgain = true;
      return;
    }
    flushing = true;
    flushChain = (async () => {
      try {
        do {
          flushAgain = false;
          lastFlushAt = Date.now();
          const written = await writeStatus(
            agent.id,
            {
              thoughts: [...thoughts],
              latestThought: thoughts[thoughts.length - 1]?.text,
              heartbeatAt: new Date().toISOString(),
            },
            ctx,
            board ?? undefined
          );
          if (written) board = written;
          // Respect the floor between coalesced rounds too, or a chatty agent
          // simply spins here instead of at the call site.
          if (flushAgain && Date.now() - lastFlushAt < TRAIL_MIN_GAP_MS) break;
        } while (flushAgain);
      } finally {
        flushing = false;
      }
    })();
  };
  /** Let an in-flight trail write finish before a status write that outranks it. */
  const settleThoughts = (): Promise<void> => flushChain.then(undefined, () => {});


  const originalLog = ctx.log;
  const runCtx: RunContext = {
    ...ctx,
    log: (message, detail) => {
      const line = detail ? `${message} ${JSON.stringify(detail)}` : message;
      thoughts.push({ at: new Date().toISOString(), text: line });
      // Keep the memory footprint bounded; the last few are all we need.
      if (thoughts.length > MAX_THOUGHTS) thoughts.shift();
      originalLog(message, detail);
      flushThoughts();
    },
  };

  board = await writeStatus(
    agent.id,
    {
      status: "running",
      phase: "thinking",
      // The agent's own start, not the tick's. ctx.now is fixed for a whole
      // cron invocation, so using it made every agent in a tick report the same
      // startedAt and made "how long has this been running" unreadable.
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
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

  // A pulse while the agent works, so a row that says "running" can be trusted.
  // Log lines already flush the board, but this agent can spend minutes inside a
  // single model call without emitting one, and silence has to stay
  // distinguishable from death. Cheap: one write a minute, and it stops the
  // moment the run leaves propose/execute.
  const beat = setInterval(flushThoughts, HEARTBEAT_MS);
  const stopBeat = (): void => clearInterval(beat);

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
    stopBeat();
    await settleThoughts();
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
  await settleThoughts();
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
  stopBeat();

  await settleThoughts();
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
