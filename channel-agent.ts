// Channel strategist.
//
// The architecture doc's original line for these agents was "timing and
// publishing of already-approved content". The owner extended it: each channel
// gets a strategist that reads its own past posts, drafts posts written for
// that specific platform, and proposes growth plays. That widens what "routine"
// covers on this batch, and it is deliberate.
//
// Routine per channel:
//   - drafting posts inside approved pillars, tuned to the platform
//   - publishing a ready draft on schedule
//
// Needs approval (unchanged from the doc):
//   - a new campaign type, direction, or format
//   - engaging specific external accounts by name (contact outside normal flow)
//   - paid promotion
//   - copy that never cleared the drafting rule
//
// A strategist that is not "active" (the flag is off, or the whole platform is
// on hold) does nothing. Facebook is idle until the owner has an account there.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type {
  AgentId,
  Channel,
  ExecutionResult,
  ProposedAction,
} from "../../core/types.js";
import { state, type ContentDraft } from "../../core/state.js";
import { getConnector } from "../../connectors/registry.js";
import { ConnectorInactiveError } from "../../connectors/types.js";
import { enqueueForPartner } from "../../connectors/linkedin.js";
import { MODELS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";
import { DEFAULT_VOICE, scanForTells, softenTells } from "../../core/voice.js";
import {
  APPROVED_FORMATS,
  CONTENT_PILLARS,
  type ContentFormat,
  type ContentPillar,
} from "../../core/config.js";
import { flag, type Env } from "../../env.js";
import {
  dueSlot,
  ensureWeeklyPlan,
  markSlotConsumed,
  type WeeklyPlanSpec,
} from "../../core/schedule.js";

// Windows and weekly plan live in src/core/schedule.ts; a strategist supplies
// a WeeklyPlanSpec via the "schedule" field below.

export interface ChannelStrategistSpec {
  id: AgentId;
  name: string;
  channel: Channel;
  description: string;
  schedule: WeeklyPlanSpec;
  /** Hard platform limit, enforced before anything reaches the connector. */
  maxLength?: number;
  /** Platform-native writing tips passed into the model prompt. */
  platformGuide: string;
  /** How the platform's audience shows engagement, in one sentence. */
  audienceLine: string;
  /**
   * A predicate that decides whether this strategist is active for this run.
   * Facebook uses `flag(env.FACEBOOK_ENABLED)`; LinkedIn always active because
   * the owner asked for it; X active because posting is a first-class goal.
   */
  active: (env: Env) => boolean;
  /**
   * Where a draft is routed when it is ready to publish. The default calls the
   * channel's connector directly (X, Facebook). LinkedIn overrides this to
   * hand the draft to the partner queue, because we do not publish there
   * ourselves.
   */
  route?: "connector" | "linkedin-partner-queue";
}

const REASONING_MODEL = MODELS.reasoning;

// Rough spend ceiling per platform per day, in ready drafts.
const TARGET_READY_PER_CHANNEL = 3;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["draft", "growth_ideas"],
  properties: {
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["text", "pillar", "format", "reasoning"],
      properties: {
        text: { type: "string", minLength: 40 },
        pillar: { type: "string", enum: [...CONTENT_PILLARS] },
        format: { type: "string", enum: [...APPROVED_FORMATS] },
        reasoning: { type: "string", maxLength: 400 },
      },
    },
    growth_ideas: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "risk"],
        properties: {
          title: { type: "string", maxLength: 120 },
          why: { type: "string", maxLength: 400 },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
} as const;

interface StrategyResult {
  draft: {
    text: string;
    pillar: ContentPillar;
    format: ContentFormat;
    reasoning: string;
  };
  growth_ideas: Array<{ title: string; why: string; risk: "low" | "medium" | "high" }>;
}

function isApprovedPillar(value: unknown): value is ContentPillar {
  return typeof value === "string" && (CONTENT_PILLARS as readonly string[]).includes(value);
}

function isApprovedFormat(value: unknown): value is ContentFormat {
  return typeof value === "string" && (APPROVED_FORMATS as readonly string[]).includes(value);
}

/**
 * Reads what this channel has done recently, so the strategist reasons about
 * this channel rather than about publishing in general. Falls back to nothing
 * if the reports table is empty; the model is told plainly when there is no
 * history yet, rather than filling the gap with invented pattern.
 */
async function readChannelHistory(
  channel: Channel,
  ctx: RunContext
): Promise<{ recentPosts: string[]; lastPublishedAt: number | null }> {
  const reports = await ctx.db.listReports({ limit: 200 });
  const own = reports.filter(
    (row) => row.channel === channel && row.action_type === "publish_post"
  );

  const recentPosts = own.slice(0, 12).map((row) => {
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    const snippet = typeof detail["text"] === "string" ? String(detail["text"]).slice(0, 220) : row.summary;
    return `- (${row.created_at?.slice(0, 10) ?? "?"}) ${snippet}`;
  });

  const lastPublishedAt = own.length
    ? Math.max(...own.map((row) => new Date(row.created_at ?? 0).getTime()))
    : null;

  return { recentPosts, lastPublishedAt };
}

async function draftForChannel(
  spec: ChannelStrategistSpec,
  ctx: RunContext,
  history: { recentPosts: string[]; lastPublishedAt: number | null }
): Promise<StrategyResult | null> {
  const memory = await ctx.db.readMemory({
    tags: [spec.channel],
    minSalience: 5,
    limit: 12,
  });

  const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n") || "(none)";
  const posts = history.recentPosts.join("\n") || "(nothing published on this channel yet)";

  const system = `You are the channel strategist for Velvex on ${spec.channel}. You draft the copy AND think about what could make the ${spec.channel} presence bigger.

${BUSINESS_CONTEXT}

${DEFAULT_VOICE.guide}

How this platform reads:
${spec.platformGuide}

How engagement shows up on this platform: ${spec.audienceLine}

Learning from past posts DOES NOT MEAN copying or paraphrasing them. It means:

- reading which openings, structures and observations landed vs stalled
- writing something new that is unmistakably you, in a shape the audience has not seen this month
- if every recent post opened the same way, deliberately break the pattern
- if every recent post named the same mechanism, name a different one

Creativity is the point. If a draft could sit inside the "recent posts" list below without anyone noticing it is new, rewrite it.

Draft exactly one post, plus zero to three growth ideas that would need the owner's approval before they run.

Every draft must:
- pick a pillar from: ${CONTENT_PILLARS.join(", ")}
- pick a format from: ${APPROVED_FORMATS.join(", ")}
- read as one specific observation, not a summary
- open differently from the openings in the recent posts below
${spec.maxLength ? `- fit within ${spec.maxLength} characters` : ""}

Growth ideas are things you would try if allowed: engaging a specific external account, a new post format, a campaign concept, a series. Each carries a risk rating. Never suggest paid promotion at low risk; it is always high.

Respond only with the JSON object described by the schema.`;

  const user = `Recent posts on ${spec.channel} (most recent first):
${posts}

Standing notes tagged ${spec.channel}:
${notes}

Now draft one new post and, if you see it, propose one to three growth ideas.`;

  const result = await ctx.claude.complete<StrategyResult>({
    model: REASONING_MODEL,
    system,
    user,
    effort: "xhigh",
    maxTokens: 4000,
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
  });

  return result.parsed ?? null;
}

export function createChannelStrategist(spec: ChannelStrategistSpec): AgentDefinition {
  return {
    id: spec.id,
    name: spec.name,
    batch: "marketing",
    description: spec.description,
    // Drafting for a platform, in that platform's register, with a growth lens.
    // Same tier as the shared Content Agent; that agent handles cross-channel
    // pieces like case notes, this one owns what is specific to the platform.
    model: REASONING_MODEL,
    effort: "xhigh",
    cadence: "hourly",
    // "internal" so a draft_content action (which is not published anywhere yet)
    // does not trip general.new_channel.
    approvedChannels: [spec.channel, "internal"],

    routineRules: [
      {
        id: `${spec.id}.draft_inside_pillars`,
        describe: "Drafting posts inside the approved pillars, formats and voice, for this channel.",
        classification: "routine",
        test: (action) => {
          if (action.type !== "draft_content") return null;
          const { pillar, format, voiceClean, channelHint } = action.payload;
          if (channelHint !== spec.channel) return null;
          if (!isApprovedPillar(pillar)) return null;
          if (!isApprovedFormat(format)) return null;
          if (voiceClean !== true) return null;
          return `Pillar "${String(pillar)}" and format "${String(format)}" are approved, the draft passes the voice check, and it is written for ${spec.channel}.`;
        },
      },
      {
        id: `${spec.id}.publish_own_draft`,
        describe: "Publishing a ready draft that this strategist wrote, on schedule.",
        classification: "routine",
        test: (action) => {
          if (action.type !== "publish_post" && action.type !== "schedule_post") return null;
          if (action.channel !== spec.channel) return null;
          if (!action.approvedContentRef) return null;
          if (action.payload["withinApprovedScope"] !== true) return null;
          if (action.payload["paid"] === true) return null;
          if (action.payload["newCampaignType"] === true) return null;
          return `Publishing draft ${action.approvedContentRef}, inside approved scope, in an established ${spec.channel} slot.`;
        },
      },
    ],

    approvalRules: [
      {
        id: `${spec.id}.growth_experiment`,
        describe: "A growth idea, by definition.",
        classification: "needs_approval",
        risk: "medium",
        test: (action) =>
          action.type === "campaign_direction" || action.payload["growthExperiment"] === true
            ? "A growth experiment on this channel is a decision, not routine work."
            : null,
      },
      {
        id: `${spec.id}.engage_external_account`,
        describe: "Engaging a specific external account by name.",
        classification: "needs_approval",
        risk: "medium",
        test: (action) =>
          action.payload["engagesExternalAccount"] === true
            ? "Engaging a specific external account is contacting someone outside the normal flow."
            : null,
      },
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
        describe: "Any paid promotion.",
        classification: "needs_approval",
        risk: "high",
        test: (action) =>
          action.payload["paid"] === true || action.type === "paid_promotion"
            ? `Paid promotion on ${spec.channel} spends money, so it waits for you.`
            : null,
      },
      {
        id: `${spec.id}.unapproved_copy`,
        describe: "Copy that has not cleared this strategist's own drafting rule.",
        classification: "needs_approval",
        risk: "medium",
        test: (action) => {
          if (action.type !== "publish_post" && action.type !== "schedule_post") return null;
          if (action.approvedContentRef && action.payload["withinApprovedScope"] === true) return null;
          return "This copy has not cleared the drafting rule, so it is not already-approved content.";
        },
      },
    ],

    async propose(ctx: RunContext): Promise<ProposedAction[]> {
      if (!spec.active(ctx.env)) {
        ctx.log(`${spec.id}: strategist idle by config`);
        return [];
      }

      const drafts = await state.contentQueue(ctx.db);
      const ready = drafts.filter(
        (draft) =>
          draft.status === "ready" &&
          (draft.channelHint === spec.channel || draft.channelHint === undefined)
      );

      const proposals: ProposedAction[] = [];

      // --- publishing pass ------------------------------------------------
      // The weekly plan holds 3 randomised slots inside English-audience windows.
      // We publish when a slot has passed and has not been consumed yet.
      const plan = await ensureWeeklyPlan(ctx.db, spec.schedule, ctx.now);
      const slot = dueSlot(plan, ctx.now);
      if (slot) {
        const history = await readChannelHistory(spec.channel, ctx);
        const withinGap =
          history.lastPublishedAt !== null &&
          ctx.now.getTime() - history.lastPublishedAt < spec.schedule.minGapHours * 3600_000;

        if (!withinGap) {
          const next = ready.find(
            (draft) => !draft.publishedOn.some((entry) => entry.channel === spec.channel)
          );
          if (next) {
            if (spec.maxLength && next.text.length > spec.maxLength) {
              proposals.push({
                type: "observation",
                summary: `Draft ${next.id} is too long for ${spec.channel} (${next.text.length}/${spec.maxLength})`,
                channel: spec.channel,
                payload: { draftId: next.id, length: next.text.length, limit: spec.maxLength },
                dedupeKey: `toolong:${spec.channel}:${next.id}`,
              });
            } else {
              proposals.push({
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
                  scheduledSlot: slot,
                },
                rationale: `Weekly plan slot at ${slot} is due and draft ${next.id} is ready.`,
                reversible: true,
                dedupeKey: `publish:${spec.channel}:${slot}`,
              });
            }
          }
        }
      }

      // --- drafting pass --------------------------------------------------
      // Only draft when the shelf for this channel is short. That caps spend
      // even on a busy schedule.
      if (ready.length >= TARGET_READY_PER_CHANNEL) {
        ctx.log(`${spec.id}: ${ready.length} channel drafts ready, no new draft this run`);
        return proposals;
      }

      const history = await readChannelHistory(spec.channel, ctx);
      let result: StrategyResult | null = null;
      try {
        result = await draftForChannel(spec, ctx, history);
      } catch (err) {
        ctx.log(`${spec.id}: drafting call failed`, { error: err instanceof Error ? err.message : String(err) });
        return proposals;
      }
      if (!result) return proposals;

      let text = softenTells(result.draft.text.trim());
      let violations = scanForTells(text);
      if (violations.length > 0) {
        // One repair pass, at the same effort. If it still reads as generated,
        // it is queued for review rather than pushed live.
        try {
          const repair = await ctx.claude.complete({
            model: REASONING_MODEL,
            system: `Rewrite the post so it does not break these voice rules: ${violations.map((v) => v.id).join(", ")}. Same point, similar length.\n\n${DEFAULT_VOICE.guide}`,
            user: text,
            effort: "high",
            maxTokens: 1500,
          });
          text = softenTells(repair.text.trim());
          violations = scanForTells(text);
        } catch {
          /* keep the first draft; the voice check below decides */
        }
      }

      proposals.push({
        type: "draft_content",
        summary: `Draft for ${spec.channel} (${result.draft.pillar}, ${result.draft.format}): ${text.slice(0, 70)}...`,
        channel: "internal",
        payload: {
          pillar: result.draft.pillar,
          format: result.draft.format,
          text,
          channelHint: spec.channel,
          authorAgent: spec.id,
          voiceClean: violations.length === 0,
          voiceViolations: violations,
          reasoning: result.draft.reasoning,
        },
        rationale:
          violations.length === 0
            ? result.draft.reasoning
            : `Drafted, but still carries voice tells: ${violations.map((v) => v.id).join(", ")}.`,
        dedupeKey: `draft:${spec.id}:${result.draft.pillar}:${result.draft.format}:${ctx.now.toISOString().slice(0, 10)}`,
      });

      for (const idea of result.growth_ideas) {
        proposals.push({
          type: "campaign_direction",
          summary: `${spec.channel} growth idea: ${idea.title}`,
          channel: spec.channel,
          payload: {
            title: idea.title,
            why: idea.why,
            risk: idea.risk,
            growthExperiment: true,
          },
          rationale: idea.why,
          dedupeKey: `growth:${spec.id}:${idea.title.slice(0, 60)}`,
        });
      }

      return proposals;
    },

    async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
      if (action.type === "observation") {
        return { outcome: "observed", detail: action.payload };
      }

      if (action.type === "draft_content") {
        const drafts = await state.contentQueue(ctx.db);
        const draft: ContentDraft = {
          id: crypto.randomUUID(),
          pillar: String(action.payload["pillar"]),
          format: String(action.payload["format"]),
          text: String(action.payload["text"]),
          createdAt: ctx.now.toISOString(),
          withinApprovedScope: action.payload["voiceClean"] === true,
          channelHint: action.payload["channelHint"] as ContentDraft["channelHint"],
          authorAgent: String(action.payload["authorAgent"] ?? spec.id),
          approvalRef: action.approvedContentRef,
          publishedOn: [],
          status: action.payload["voiceClean"] === true ? "ready" : "needs_revision",
        };
        drafts.unshift(draft);
        await state.saveContentQueue(ctx.db, drafts);
        return {
          outcome: "executed",
          externalRef: draft.id,
          detail: {
            draftId: draft.id,
            channelHint: draft.channelHint,
            pillar: draft.pillar,
            format: draft.format,
            status: draft.status,
          },
        };
      }

      if (action.type === "campaign_direction") {
        // Only reachable after approval. Record the direction; the actual
        // experiment is carried out by later drafts and publishes.
        await ctx.db.writeMemory({
          key: `growth.${spec.channel}.${ctx.now.toISOString().slice(0, 10)}.${crypto.randomUUID().slice(0, 8)}`,
          scope: spec.id,
          kind: "decision",
          content: String(action.payload["title"] ?? action.summary),
          detail: action.payload,
          salience: 8,
          source_agent: spec.id,
          tags: [spec.channel, "growth"],
        });
        return { outcome: "executed", detail: action.payload };
      }

      // Publishing.
      const text = String(action.payload["text"] ?? "");
      const draftId = String(action.payload["draftId"] ?? action.target ?? "");
      const stampPublished = async (ref: string) => {
        const drafts = await state.contentQueue(ctx.db);
        const draft = drafts.find((item) => item.id === draftId);
        if (draft) {
          draft.publishedOn.push({
            channel: spec.channel,
            ref,
            at: ctx.now.toISOString(),
          });
          await state.saveContentQueue(ctx.db, drafts);
        }
      };

      if (spec.route === "linkedin-partner-queue") {
        // We do not post to LinkedIn ourselves. The strategist drafts, the
        // outside partner agent collects and publishes. If the partner is not
        // wired up yet, the draft still lands in the queue and waits.
        if (!flag(ctx.env.LINKEDIN_INTEGRATION_ENABLED) || !ctx.env.LINKEDIN_PARTNER_TOKEN) {
          const queued = await enqueueForPartner(ctx.db, {
            text,
            approvalRef: action.approvedContentRef,
            pillar: String(action.payload["pillar"] ?? ""),
            format: String(action.payload["format"] ?? ""),
          });
          return {
            outcome: "blocked_inactive",
            externalRef: queued.id,
            detail: {
              note: "LinkedIn draft queued. It publishes as soon as the partner integration is switched on.",
              draftId,
              waitingOn: ["LINKEDIN_INTEGRATION_ENABLED", "LINKEDIN_PARTNER_TOKEN"],
            },
          };
        }
        const queued = await enqueueForPartner(ctx.db, {
          text,
          approvalRef: action.approvedContentRef,
          pillar: String(action.payload["pillar"] ?? ""),
          format: String(action.payload["format"] ?? ""),
        });
        await stampPublished(queued.id);
        const usedSlot = action.payload["scheduledSlot"];
        if (typeof usedSlot === "string") {
          const currentPlan = await ensureWeeklyPlan(ctx.db, spec.schedule, ctx.now);
          await markSlotConsumed(ctx.db, spec.schedule, usedSlot, currentPlan);
        }
        return {
          outcome: "executed",
          externalRef: queued.id,
          detail: {
            note: "Queued for the LinkedIn partner agent to publish.",
            draftId,
          },
        };
      }

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
        await stampPublished(result.externalRef);
        const usedSlot = action.payload["scheduledSlot"];
        if (typeof usedSlot === "string") {
          const currentPlan = await ensureWeeklyPlan(ctx.db, spec.schedule, ctx.now);
          await markSlotConsumed(ctx.db, spec.schedule, usedSlot, currentPlan);
        }
        return {
          outcome: "executed",
          externalRef: result.externalRef,
          detail: { url: result.url, scheduled: result.scheduled, draftId },
        };
      } catch (err) {
        if (err instanceof ConnectorInactiveError) {
          return {
            outcome: "blocked_inactive",
            detail: {
              draftId,
              channel: spec.channel,
              waitingOn: err.missing,
              note: "Draft written and held. It sends as soon as credentials are supplied.",
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

/** Backwards compatibility so the channel files can keep their existing imports. */
export const createChannelAgent = createChannelStrategist;
