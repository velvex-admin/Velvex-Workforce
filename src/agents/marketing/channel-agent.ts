// Shared behaviour for the publishing channel agents (Facebook, X).
//
// Architecture doc, for each of them:
//   Routine        timing and publishing of already-approved content
//   Needs approval new campaign type or any paid promotion
//
// So the agent decides *when*, and publishes what the content agent already
// produced inside approved scope. It never writes its own copy, and it cannot
// publish a draft that did not clear the content agent's rules: the routine
// rule requires an approvedContentRef that resolves to a ready draft.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { AgentId, Channel, ExecutionResult, ProposedAction } from "../../core/types.js";
import { state } from "../../core/state.js";
import { getConnector } from "../../connectors/registry.js";
import { ConnectorInactiveError } from "../../connectors/types.js";

export interface ChannelSchedule {
  /** Hours (UTC) at which this channel posts. */
  hours: number[];
  /** Days of week it posts on, 0 = Sunday. */
  days: number[];
  /** Never post twice within this many hours. */
  minGapHours: number;
}

export interface ChannelAgentSpec {
  id: AgentId;
  name: string;
  channel: Channel;
  description: string;
  schedule: ChannelSchedule;
  /** Hard platform limit, enforced before anything is sent. */
  maxLength?: number;
}

function slotIsDue(schedule: ChannelSchedule, now: Date): boolean {
  return schedule.days.includes(now.getUTCDay()) && schedule.hours.includes(now.getUTCHours());
}

export function createChannelAgent(spec: ChannelAgentSpec): AgentDefinition {
  return {
    id: spec.id,
    name: spec.name,
    batch: "marketing",
    description: spec.description,
    // No model calls at all. Working out whether a slot is due and picking the
    // oldest unpublished draft is a clock and a list. The copy already came
    // through the content agent on the reasoning tier.
    model: null,
    effort: "medium",
    cadence: "hourly",
    approvedChannels: [spec.channel],

    routineRules: [
      {
        id: `${spec.id}.publish_approved_content`,
        describe: "Publishing content that already cleared the content agent, at an approved time.",
        classification: "routine",
        test: (action) => {
          if (action.type !== "publish_post" && action.type !== "schedule_post") return null;
          if (action.channel !== spec.channel) return null;
          if (!action.approvedContentRef) return null;
          if (action.payload["withinApprovedScope"] !== true) return null;
          if (action.payload["paid"] === true) return null;
          if (action.payload["newCampaignType"] === true) return null;
          return `Publishing draft ${action.approvedContentRef}, which is already inside approved scope, in an established ${spec.channel} slot.`;
        },
      },
    ],

    approvalRules: [
      {
        id: `${spec.id}.new_campaign_type`,
        describe: "A campaign type nobody has run before.",
        classification: "needs_approval",
        risk: "high",
        test: (action) =>
          action.payload["newCampaignType"] === true || action.type === "campaign_type"
            ? `A new campaign type on ${spec.channel} is yours to approve.`
            : null,
      },
      {
        id: `${spec.id}.paid_promotion`,
        describe: "Any paid promotion, at any budget.",
        classification: "needs_approval",
        risk: "high",
        test: (action) =>
          action.payload["paid"] === true || action.type === "paid_promotion"
            ? `Paid promotion on ${spec.channel} spends money, so it waits for you.`
            : null,
      },
      {
        id: `${spec.id}.unapproved_copy`,
        describe: "Copy that did not come through the content agent's approved scope.",
        classification: "needs_approval",
        risk: "medium",
        test: (action) => {
          if (action.type !== "publish_post" && action.type !== "schedule_post") return null;
          if (action.approvedContentRef && action.payload["withinApprovedScope"] === true) return null;
          return "This copy has not cleared the content agent, so it is not already-approved content.";
        },
      },
    ],

    async propose(ctx: RunContext): Promise<ProposedAction[]> {
      if (!slotIsDue(spec.schedule, ctx.now) && ctx.trigger === "cron") {
        return [];
      }

      const drafts = await state.contentQueue(ctx.db);
      const alreadyOnChannel = drafts.filter((draft) =>
        draft.publishedOn.some((entry) => entry.channel === spec.channel)
      );

      const lastPost = alreadyOnChannel
        .flatMap((draft) => draft.publishedOn.filter((entry) => entry.channel === spec.channel))
        .map((entry) => new Date(entry.at).getTime())
        .sort((a, b) => b - a)[0];

      if (lastPost && ctx.now.getTime() - lastPost < spec.schedule.minGapHours * 3600_000) {
        ctx.log(`${spec.id}: inside the minimum gap since the last post`);
        return [];
      }

      const next = drafts.find(
        (draft) =>
          draft.status === "ready" &&
          !draft.publishedOn.some((entry) => entry.channel === spec.channel)
      );

      if (!next) {
        ctx.log(`${spec.id}: nothing ready to publish`);
        return [];
      }

      if (spec.maxLength && next.text.length > spec.maxLength) {
        return [
          {
            type: "observation",
            summary: `Draft ${next.id} is too long for ${spec.channel} (${next.text.length}/${spec.maxLength})`,
            channel: spec.channel,
            payload: { draftId: next.id, length: next.text.length, limit: spec.maxLength },
            dedupeKey: `toolong:${spec.channel}:${next.id}`,
          },
        ];
      }

      return [
        {
          type: "publish_post",
          summary: `Publish to ${spec.channel}: ${next.text.slice(0, 70)}...`,
          channel: spec.channel,
          target: next.id,
          approvedContentRef: next.id,
          payload: {
            draftId: next.id,
            text: next.text,
            withinApprovedScope: next.withinApprovedScope,
            pillar: next.pillar,
            format: next.format,
          },
          rationale: `Slot is due and draft ${next.id} is ready and unpublished on ${spec.channel}.`,
          reversible: true,
          dedupeKey: `publish:${spec.channel}:${next.id}`,
        },
      ];
    },

    async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
      if (action.type === "observation") {
        return { outcome: "observed", detail: action.payload };
      }

      const text = String(action.payload["text"] ?? "");
      const draftId = String(action.payload["draftId"] ?? action.target ?? "");

      try {
        const connector = getConnector(spec.channel);
        const result = await connector.publish(
          {
            text,
            idempotencyKey: `${spec.channel}:${draftId}`,
            ...(action.type === "schedule_post" && typeof action.payload["scheduledFor"] === "string"
              ? { scheduledFor: action.payload["scheduledFor"] }
              : {}),
          },
          ctx.env
        );

        const drafts = await state.contentQueue(ctx.db);
        const draft = drafts.find((item) => item.id === draftId);
        if (draft) {
          draft.publishedOn.push({
            channel: spec.channel,
            ref: result.externalRef,
            at: ctx.now.toISOString(),
          });
          await state.saveContentQueue(ctx.db, drafts);
        }

        return {
          outcome: "executed",
          externalRef: result.externalRef,
          detail: { url: result.url, scheduled: result.scheduled, draftId },
        };
      } catch (err) {
        if (err instanceof ConnectorInactiveError) {
          // Not a failure. The connector is waiting on credentials, the draft
          // stays queued, and this is recorded as exactly that.
          return {
            outcome: "blocked_inactive",
            detail: {
              draftId,
              channel: spec.channel,
              waitingOn: err.missing,
              note: "Agent logic ran to completion. Publishing is held until credentials are supplied.",
            },
          };
        }
        return {
          outcome: "failed",
          error: err instanceof Error ? err.message : String(err),
          detail: { draftId, channel: spec.channel },
        };
      }
    },
  };
}
