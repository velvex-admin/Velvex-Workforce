// Chief-of-Staff — Orchestration.
//
// Architecture doc: every other agent reports to it — what it did, what it
// wants to do next. It filters: routine updates get logged to the reports
// table; anything that looks like a new idea or a problem gets written to the
// pending-approvals table. It queries its own memory store when it needs
// context, rather than you checking each agent individually.
//
// This file is both halves of that: the Coordinator every other agent hands its
// work to, and an agent in its own right that rolls the day up.

import type {
  AgentDefinition,
  Coordinator,
  RunContext,
} from "../../core/agent.js";
import type {
  AgentReport,
  ExecutionResult,
  ProposedAction,
  RuleDecision,
} from "../../core/types.js";
import { state } from "../../core/state.js";
import { dedupeKey } from "../../core/proposal-key.js";

import { MODELS } from "../../core/models.js";

const MODEL = MODELS.reasoning;


export const chiefOfStaff: Coordinator = {
  /**
   * Routine activity. Goes to the reports table, and nowhere else — unless it
   * is a failure, which is a problem, and problems are yours to see.
   */
  async receiveReport(report: AgentReport, ctx: RunContext): Promise<void> {
    await ctx.db.insertReport({
      agent_id: report.agentId,
      agent_batch: report.batch,
      action_type: report.actionType,
      summary: report.summary,
      detail: report.detail ?? {},
      classification: report.approvalId ? "approved" : "routine",
      outcome: report.outcome,
      channel: report.channel ?? null,
      external_ref: report.externalRef ?? null,
      approval_id: report.approvalId ?? null,
      run_id: ctx.runId,
      model: report.model ?? null,
      effort: report.effort ?? null,
      usage: report.usage ?? null,
      error: report.error ?? null,
    });

    // A connector without credentials is a known state, not a problem: it shows
    // on the dashboard as inactive and does not fill the approvals queue.
    if (report.outcome !== "failed") return;

    const day = ctx.now.toISOString().slice(0, 10);
    await ctx.db.queueApproval({
      agent_id: report.agentId,
      agent_batch: report.batch,
      title: `${report.agentId} hit a problem: ${report.summary}`,
      rationale:
        report.error ??
        "The agent reported a failure with no further detail. It has stopped rather than retrying blindly.",
      action: {
        type: "observation",
        summary: report.summary,
        payload: { problem: true, agentId: report.agentId, error: report.error ?? null },
      },
      trigger_rule: "chief_of_staff.problem_escalation",
      trigger_reason: "A failed action is a problem, and problems go to you rather than into the log.",
      risk: "medium",
      dedupe_key: `problem:${report.agentId}:${report.summary}:${day}`.slice(0, 300),
    });
  },

  /** A new idea, or something outside routine scope. Goes to the queue. */
  async escalate(
    args: { agent: AgentDefinition; action: ProposedAction; decision: RuleDecision },
    ctx: RunContext
  ): Promise<{ queued: boolean; approvalId?: string }> {
    const { agent, action, decision } = args;

    const row = await ctx.db.queueApproval({
      agent_id: agent.id,
      agent_batch: agent.batch,
      title: action.summary,
      rationale:
        action.rationale ??
        `${agent.name} proposed this. ${decision.reason}`,
      action,
      trigger_rule: decision.ruleId,
      trigger_reason: decision.reason,
      risk: decision.risk,
      dedupe_key: dedupeKey(agent.id, action),
    });

    if (!row) {
      ctx.log(`${agent.id}: identical proposal already waiting, not queued again`);
      return { queued: false };
    }
    return { queued: true, approvalId: row.id };
  },
};

// ---------------------------------------------------------------------------
// The Chief-of-Staff as an agent: the daily roll-up and the memory it keeps.
// ---------------------------------------------------------------------------

const SYSTEM = `You are the Chief-of-Staff of Velvex, an institutional-grade commercial architecture diagnostic. Every other agent in the system reports to you.

You are given the last day of agent activity and the notes you kept previously. Produce a short internal briefing for the owner:

- What actually happened, in plain words. No restating the log line by line.
- What is stuck, and for how long.
- What you would put in front of the owner first, and why.

Write tightly. No preamble, no sign-off, no headings unless they earn their place. Never use em dashes. If nothing meaningful happened, say that in one line rather than padding.`;

export const chiefOfStaffAgent: AgentDefinition = {
  id: "chief_of_staff",
  name: "Chief-of-Staff",
  batch: "orchestration",
  description:
    "Every other agent reports to it. Filters routine activity into the log and anything new or broken into the approvals queue; keeps the memory that gives the system continuity.",
  // It decides what reaches you and what stays in the log, so it keeps the
  // reasoning tier. Once a day, over a day of log lines, that is cents.
  model: MODEL,
  effort: "high",
  cadence: "daily",
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "chief_of_staff.log_and_remember",
      describe: "Summarising activity and keeping memory is the whole job.",
      classification: "routine",
      test: (action) =>
        action.type === "observation" || action.type === "memory_write"
          ? "Writing up activity and keeping memory is this agent's routine work."
          : null,
    },
  ],

  approvalRules: [
    {
      id: "chief_of_staff.no_acting_for_others",
      describe: "The Chief-of-Staff coordinates. It does not act on other agents' behalf.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.type !== "observation" && action.type !== "memory_write"
          ? `Coordination only: "${action.type}" would be acting, which belongs to the agent that owns it.`
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const since = new Date(ctx.now.getTime() - 24 * 3600_000).toISOString();
    const reports = await ctx.db.listReports({ limit: 120 });
    const window = reports.filter((row) => (row.created_at ?? "") >= since);

    const pending = await ctx.db.listApprovals("pending", 50);
    const memory = await ctx.db.readMemory({ minSalience: 6, limit: 25 });

    if (window.length === 0 && pending.length === 0) {
      return [
        {
          type: "observation",
          summary: "Nothing to report in the last 24 hours",
          payload: { quiet: true },
          dedupeKey: `rollup:quiet:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    const activity = window
      .map(
        (row) =>
          `- [${row.agent_id}] ${row.action_type}: ${row.summary} (${row.outcome})` +
          (row.error ? ` ERROR: ${row.error}` : "")
      )
      .join("\n");

    const waiting = pending
      .map((row) => `- [${row.agent_id}] ${row.title} (rule ${row.trigger_rule}, risk ${row.risk})`)
      .join("\n");

    const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n");

    const briefing = await ctx.claude.complete({
      system: SYSTEM,
      user:
        `Activity, last 24 hours (${window.length} entries):\n${activity || "(none)"}\n\n` +
        `Waiting on the owner (${pending.length}):\n${waiting || "(none)"}\n\n` +
        `Your standing notes:\n${notes || "(none)"}`,
      model: MODEL,
      effort: chiefOfStaffAgent.effort,
      maxTokens: 2000,
    });

    return [
      {
        type: "observation",
        summary: `Daily roll-up: ${window.length} actions, ${pending.length} waiting on you`,
        payload: {
          briefing: briefing.text,
          actionCount: window.length,
          pendingCount: pending.length,
        },
        dedupeKey: `rollup:${ctx.now.toISOString().slice(0, 10)}`,
      },
    ];
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type === "observation" && typeof action.payload["briefing"] === "string") {
      await state.write(
        ctx.db,
        `rollup.${ctx.now.toISOString().slice(0, 10)}`,
        { briefing: action.payload["briefing"], generatedAt: ctx.now.toISOString() },
        action.summary,
        { scope: "chief_of_staff", agent: "chief_of_staff", salience: 8, tags: ["rollup"] }
      );
      return {
        outcome: "executed",
        detail: { briefing: action.payload["briefing"] },
      };
    }

    if (action.type === "memory_write") {
      await ctx.db.writeMemory({
        key: String(action.payload["key"] ?? `note.${crypto.randomUUID()}`),
        scope: String(action.payload["scope"] ?? "global"),
        kind: "fact",
        content: String(action.payload["content"] ?? action.summary),
        detail: (action.payload["detail"] as Record<string, unknown>) ?? {},
        salience: Number(action.payload["salience"] ?? 5),
        source_agent: "chief_of_staff",
      });
      return { outcome: "executed" };
    }

    return { outcome: "observed", detail: { note: "Nothing to carry out." } };
  },
};
