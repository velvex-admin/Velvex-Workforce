// Marketing Analytics Agent — Marketing.
//
// Doc: tracks which channel is actually producing signups and feeds that up to
// the Chief-of-Staff — the source for decisions like "cut the underperforming
// channel, put more into what's working".
//
//   Routine        all of it; this agent only observes and reports, never acts
//                  externally
//   Needs approval N/A
//
// observeOnly is set, so the runner refuses to let it act even if a future
// change to this file tried to. That is deliberate: "never acts externally" is
// the whole character of this agent.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { STATE_KEYS, state } from "../../core/state.js";
import { facebookConnector } from "../../connectors/facebook.js";
import { xConnector } from "../../connectors/x.js";
import { readMetrics as readLinkedInMetrics } from "../../connectors/linkedin.js";
import { ConnectorInactiveError, type ChannelMetrics } from "../../connectors/types.js";

const WINDOW_DAYS = 30;

interface ChannelLine {
  channel: string;
  status: "live" | "inactive" | "partner-reported" | "no data";
  metrics?: ChannelMetrics;
  signups: number;
  note?: string;
}

export const marketingAnalyticsAgent: AgentDefinition = {
  id: "marketing_analytics",
  name: "Marketing Analytics Agent",
  batch: "marketing",
  description:
    "Tracks which channel is actually producing signups and feeds that to the Chief-of-Staff. Observes and reports only.",
  effort: "medium", // aggregation and a short written read of it
  cadence: "daily",
  observeOnly: true,
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "marketing_analytics.observe_and_report",
      describe: "All of it. This agent only observes and reports.",
      classification: "routine",
      test: (action) =>
        action.type === "observation" || action.type === "memory_write"
          ? "Observing and reporting is this agent's entire routine scope."
          : null,
    },
  ],

  // Nothing agent-specific: anything that is not an observation is already
  // stopped by the observe-only guard in the runner before rules are reached.
  approvalRules: [],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const signups = await state.signups(ctx.db);
    const lines: ChannelLine[] = [];

    const collect = async (
      channel: string,
      fetch: () => Promise<ChannelMetrics>
    ): Promise<ChannelLine> => {
      try {
        const metrics = await fetch();
        return {
          channel,
          status: "live",
          metrics,
          signups: signups?.byChannel[channel] ?? 0,
        };
      } catch (err) {
        if (err instanceof ConnectorInactiveError) {
          return {
            channel,
            status: "inactive",
            signups: signups?.byChannel[channel] ?? 0,
            note: `waiting on ${err.missing.join(", ")}`,
          };
        }
        return {
          channel,
          status: "no data",
          signups: signups?.byChannel[channel] ?? 0,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    };

    lines.push(await collect("facebook", () => facebookConnector.fetchMetrics(ctx.env, WINDOW_DAYS)));
    lines.push(await collect("x", () => xConnector.fetchMetrics(ctx.env, WINDOW_DAYS)));

    const linkedin = await readLinkedInMetrics(ctx.db);
    lines.push({
      channel: "linkedin",
      status: linkedin ? "partner-reported" : "no data",
      metrics: linkedin ?? undefined,
      signups: signups?.byChannel["linkedin"] ?? 0,
      note: linkedin ? undefined : "the external LinkedIn agent has not reported metrics yet",
    });

    const totalSignups = lines.reduce((sum, line) => sum + line.signups, 0);
    const anyData = lines.some((line) => line.metrics) || totalSignups > 0;

    if (!anyData) {
      return [
        {
          type: "observation",
          summary: "No channel data yet: every publishing channel is inactive or silent",
          payload: {
            lines,
            note:
              "Facebook and X are waiting on credentials, and the LinkedIn partner agent has not reported. " +
              "Nothing here is a performance judgement, because there is no performance to judge.",
          },
          dedupeKey: `analytics:no-data:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    const table = lines
      .map(
        (line) =>
          `${line.channel}: ${line.status}` +
          (line.metrics
            ? `, ${line.metrics.impressions ?? "?"} impressions, ${line.metrics.engagements ?? "?"} engagements, ${line.metrics.posts ?? "?"} posts`
            : "") +
          `, ${line.signups} signups` +
          (line.note ? ` (${line.note})` : "")
      )
      .join("\n");

    const read = await ctx.claude.complete({
      system:
        "You read marketing channel numbers for a small consulting business and say what they mean. " +
        "Be blunt about what is not working. Never invent a number that is not in front of you, and " +
        "say plainly when a channel has too little data to judge. No em dashes. Four sentences at most.",
      user: `Window: last ${WINDOW_DAYS} days.\n\n${table}\n\nWhat does this say about where signups are coming from?`,
      effort: marketingAnalyticsAgent.effort,
      maxTokens: 800,
    });

    return [
      {
        type: "observation",
        summary: `Channel performance, ${WINDOW_DAYS} days: ${totalSignups} signups across ${lines.length} channels`,
        payload: { lines, read: read.text, windowDays: WINDOW_DAYS, totalSignups },
        dedupeKey: `analytics:${ctx.now.toISOString().slice(0, 10)}`,
      },
    ];
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    await state.write(
      ctx.db,
      STATE_KEYS.channelPerformance,
      {
        collectedAt: ctx.now.toISOString(),
        lines: action.payload["lines"],
        read: action.payload["read"] ?? null,
      },
      action.summary,
      {
        scope: "marketing_analytics",
        agent: "marketing_analytics",
        salience: 8,
        tags: ["marketing", "metrics"],
      }
    );

    return { outcome: "observed", detail: { summary: action.summary } };
  },
};
