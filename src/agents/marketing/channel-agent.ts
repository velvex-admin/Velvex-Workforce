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

import type { AgentDefinition, AgentRequirement, RunContext } from "../../core/agent.js";
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
import { linkedInDirectConnector } from "../../connectors/linkedin-direct.js";
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
import { dedupeKey } from "../../core/proposal-key.js";
import {
  demote,
  learningContext,
  recordEpisodes,
  shouldForm,
  type Episode,
  type LearningRecord,
} from "../../core/learning.js";
import {
  absorbVerdicts,
  episodesFor,
  buildFeatures,
  formLessons,
  readLearning,
  writeLearning,
} from "../../core/learning-store.js";
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
  /**
   * Whether this strategist keeps a learning record: episodes of what it
   * proposed, the owner's rulings on them, and the lessons formed from those.
   *
   * Off by default, and on for X only. Not because the other channels could not
   * use it, but because a layer that shapes public copy should be watched on one
   * channel before it shapes three. The factory is shared, so turning it on
   * elsewhere is this one flag — which is the point of putting it here rather
   * than forking the file.
   *
   * What it learns from is the owner's approve/reject decisions and nothing
   * else. There is no audience signal on any of these channels today: X's free
   * tier posts but does not read, so `fetchMetrics()` 402s and no post has ever
   * reported an impression back. See `learningContext()` for how that absence is
   * stated to the model rather than left for it to fill in.
   */
  learning?: boolean;

  /**
   * Every post on this channel waits for the owner before it goes out.
   *
   * The default across this system is that publishing a draft the strategist
   * itself wrote, inside approved pillars and into an established slot, is
   * routine. That is right for a channel whose voice is settled. It is not right
   * for a channel the owner is still shaping: the cost of one generic post on a
   * company page is not one bad post, it is the page reading as automated to
   * everyone who sees it afterwards.
   *
   * So this turns publishing into a veto. The owner reads the exact text, and
   * approving it is what publishes it. Rejecting it takes that draft out of the
   * running for this channel and the agent writes something else.
   */
  approveBeforePublish?: boolean;

  /**
   * The page's own voice, from before the agent existed.
   *
   * `readChannelHistory` reads what THIS SYSTEM published, which on a channel it
   * has never posted to is nothing at all — so the model would be told "nothing
   * published on this channel yet" about a page with a year of posts on it and
   * would invent a register from the guide alone. That is exactly how an agent
   * arrives generic on day one.
   *
   * Carries both halves deliberately. Examples alone teach a house style; the
   * contrast between what the page is moving toward and what it has moved away
   * from teaches the judgement, and this page's own trajectory is the clearest
   * statement of that judgement available.
   *
   * It is a starting register, not a library: once there is real history, that
   * history is what the model reasons over.
   */
  /** Passed straight through to the AgentDefinition. See AgentRequirement. */
  requires?: AgentRequirement[];

  voiceBaseline?: {
    target: Array<{ text: string }>;
    avoid: Array<{ why: string; text: string }>;
  };
}

const REASONING_MODEL = MODELS.reasoning;

// Rough spend ceiling per platform per day, in ready drafts.
const TARGET_READY_PER_CHANNEL = 3;

/**
 * Whether any channel reports audience response back to us. It does not.
 *
 * X's free tier posts but does not read: `/2/users/me` and the timeline
 * endpoint `fetchMetrics()` needs both return 402 until a paid tier is active,
 * so no post this system has ever published has reported an impression. LinkedIn
 * publishes through a partner queue we hold no API credentials for. Facebook is
 * dormant.
 *
 * This is a constant rather than a per-spec flag because it is one fact about
 * the whole system's connectivity, and because making it a flag invites someone
 * to set it true on a channel that still cannot read. When read access is
 * bought, this becomes the switch that turns the semantic layer on — and the
 * work behind it is per-post metric retrieval keyed on the `external_ref` every
 * published report already stores, not just flipping this.
 */
const HAS_AUDIENCE_DATA = false;

/**
 * The proposal types a strategist can be ruled on, and the episode kind each
 * becomes. Shared between the recording path and the back-fill so the two
 * cannot disagree about what counts.
 *
 * Growth ideas always queue by design, so they always carry a verdict. A
 * PUBLISH normally does not: on every channel but one it classifies routine and
 * goes out without anyone deciding anything, and an episode for it would sit
 * unresolved for ever and drag the ring down with it.
 *
 * `approveBeforePublish` inverts exactly that. On a channel where every post
 * waits for the owner, a publish ruling is the densest and most direct signal
 * this system has anywhere: it is a verdict on the copy itself, not on an idea
 * about copy. Not collecting it would mean learning about LinkedIn from the
 * handful of growth ideas while ignoring the owner's verdict on every post.
 *
 * A connector failure is not a ruling, and is already excluded here without a
 * special case: the Chief-of-Staff files a problem escalation with
 * `action.type: "observation"`, so it never matches either entry below.
 */
function learnsFrom(spec: ChannelStrategistSpec): Record<string, Episode["kind"]> {
  return {
    campaign_direction: "growth_idea",
    ...(spec.approveBeforePublish
      ? { publish_post: "draft" as const, schedule_post: "draft" as const }
      : {}),
  };
}

export const DRAFT_SCHEMA = {
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
      // No maxItems here: the API rejects array length constraints in a
      // structured-output schema. The cap is stated in the prompt and enforced
      // in code below, where we slice before proposing.
      type: "array",
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
export async function readChannelHistory(
  channel: Channel,
  ctx: RunContext
): Promise<{ recentPosts: string[]; lastPublishedAt: number | null }> {
  const reports = await ctx.db.listReports({ limit: 200 });
  // Attempts that failed are not posts. Counting them made a failure set the
  // minimum-gap clock, so one refusal from the platform silently suppressed
  // publishing for the next 30 hours, and the next attempt after that reset it
  // again. It also fed copy nobody ever saw back to the model as "what you
  // recently posted", which is exactly the history it is told not to repeat.
  const own = reports.filter(
    (row) =>
      row.channel === channel &&
      row.action_type === "publish_post" &&
      row.outcome === "executed"
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
  history: { recentPosts: string[]; lastPublishedAt: number | null },
  learned: string | null
): Promise<StrategyResult | null> {
  const memory = await ctx.db.readMemory({
    tags: [spec.channel],
    minSalience: 5,
    limit: 12,
  });

  const notes = memory.map((row) => `- ${row.key}: ${row.content}`).join("\n") || "(none)";
  const posts = history.recentPosts.join("\n") || "(nothing published on this channel yet)";

  // Only while this system has published nothing here. After that the page's
  // real history is richer and current, and carrying a frozen baseline beside it
  // would compete with it — the additive-memory failure this repo has paid for
  // twice already.
  const baseline =
    spec.voiceBaseline && history.recentPosts.length === 0
      ? `\nThe page already exists and has a voice, written by the owner before you. This is it.\n\nWRITE LIKE THIS:\n\n${spec.voiceBaseline.target
          .map((sample, i) => `[${i + 1}]\n${sample.text}`)
          .join("\n\n")}\n\nDO NOT WRITE LIKE THIS. These are earlier posts from the same page that it has deliberately moved away from:\n\n${spec.voiceBaseline.avoid
          .map((sample, i) => `[${i + 1}] ${sample.why}\n${sample.text}`)
          .join("\n\n")}\n\nYour job is to continue the first list, not to average the two.\n`
      : "";

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
${baseline}
Standing notes tagged ${spec.channel}:
${notes}
${learned ? `\n${learned}\n` : ""}
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

/**
 * Take drafts the owner turned down out of this channel's running.
 *
 * Rejection deliberately has no hook anywhere in this system: rulings are read
 * back by the agent that cares, at the start of its own run. `absorbRejections()`
 * in the intelligence agent does exactly this for candidates, and the learning
 * layer does it for verdicts. This is the third instance of the same pattern.
 *
 * It is not optional bookkeeping. `queueApproval` ignores a duplicate dedupe key
 * whatever its status, and a publish proposal's key is stable for a given draft
 * and slot — so a rejected draft that stayed available would be re-picked every
 * tick, silently fail to re-queue, and the channel would simply stop producing.
 * Marking it declined is what frees the shelf so the drafting pass writes
 * something else, which is the whole point of rejecting it.
 */
async function absorbDeclines(
  spec: ChannelStrategistSpec,
  drafts: ContentDraft[],
  ctx: RunContext
): Promise<ContentDraft[]> {
  const approvals = await ctx.db.listApprovals("rejected", 50);
  const declined = new Set<string>();
  for (const row of approvals) {
    if (row.agent_id !== spec.id) continue;
    const action = row.action as ProposedAction | undefined;
    if (!action) continue;
    if (action.type !== "publish_post" && action.type !== "schedule_post") continue;
    const draftId = action.payload?.["draftId"];
    if (typeof draftId === "string") declined.add(draftId);
  }
  if (declined.size === 0) return drafts;

  let changed = 0;
  const next = drafts.map((draft) => {
    if (!declined.has(draft.id)) return draft;
    const already = (draft.declinedOn ?? []).some((entry) => entry.channel === spec.channel);
    if (already) return draft;
    changed += 1;
    return {
      ...draft,
      declinedOn: [
        ...(draft.declinedOn ?? []),
        { channel: spec.channel, at: ctx.now.toISOString() },
      ],
    };
  });

  if (changed === 0) return drafts;
  ctx.log(`${spec.id}: ${changed} draft(s) declined by the owner, taken out of the running`);
  await state.saveContentQueue(ctx.db, next);
  return next;
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
    ...(spec.requires ? { requires: spec.requires } : {}),

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
      // Ordered first because it is the broadest veto on this channel. Approval
      // rules are evaluated before routine rules and any hit queues the action,
      // so this beats `publish_own_draft` without that rule needing to know.
      ...(spec.approveBeforePublish
        ? [
            {
              id: `${spec.id}.publish_needs_sign_off`,
              describe: `Every ${spec.channel} post waits for the owner to read it.`,
              classification: "needs_approval" as const,
              risk: "medium" as const,
              test: (action: ProposedAction) =>
                action.type === "publish_post" || action.type === "schedule_post"
                  ? `Posts to the ${spec.channel} page are read by the owner before they go out.`
                  : null,
            },
          ]
        : []),
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

      let drafts = await state.contentQueue(ctx.db);
      if (spec.approveBeforePublish) {
        drafts = await absorbDeclines(spec, drafts, ctx);
      }
      const ready = drafts.filter(
        (draft) =>
          draft.status === "ready" &&
          (draft.channelHint === spec.channel || draft.channelHint === undefined)
      );

      // A draft this channel has already published is history, not stock.
      //
      // Nothing ever moves a draft off "ready": `publishedOn` is the only record
      // that it went out, and that is deliberate, because a channel-neutral
      // draft published on X may still be due on LinkedIn. So availability is
      // per channel, and BOTH passes below have to ask the same question.
      //
      // They did not. The publish pass filtered on `publishedOn` and the shelf
      // count did not, so a shelf holding three already-published drafts read as
      // full to one pass and empty to the other, and the two answers deadlocked
      // the agent: the publish pass found nothing left to send, the drafting
      // pass returned early because the shelf looked stocked, and the shelf
      // could only ever drain by publishing. X sat exactly like that from
      // 2026-08-25 to 2026-08-30 with three permanently unpublishable drafts and
      // no error anywhere, and it took the learning layer with it, since that
      // lives inside the drafting path.
      const available = ready.filter(
        (draft) =>
          !draft.publishedOn.some((entry) => entry.channel === spec.channel) &&
          !(draft.declinedOn ?? []).some((entry) => entry.channel === spec.channel)
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
          const next = available[0];
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
      if (available.length >= TARGET_READY_PER_CHANNEL) {
        ctx.log(`${spec.id}: ${available.length} channel drafts ready, no new draft this run`);
        return proposals;
      }

      const history = await readChannelHistory(spec.channel, ctx);

      // --- learning: read, absorb, form -----------------------------------
      //
      // This is deliberately INSIDE the drafting path rather than at the top of
      // propose(). The strategist wakes hourly but only drafts when its shelf is
      // short, so putting the learning work here means it costs three
      // subrequests on the runs that were already going to make a model call,
      // and nothing at all on the rest. On an hourly tick whose subrequest
      // budget is already tight enough to kill the last agent in it, that
      // distinction is the difference between a layer that pays for itself and
      // one that breaks its neighbours.
      //
      // Failure here must never cost the run its draft. A learning record is an
      // optimisation; the post is the work. So the whole block is guarded and a
      // failure degrades to drafting with no lessons, which is what the agent
      // did before this existed.
      let record: LearningRecord | null = null;
      let learned: string | null = null;
      if (spec.learning) {
        try {
          record = await readLearning(ctx.db, spec.id, ctx.now);
          // The back-fill spec names what this agent records episodes FOR, and
          // it is the same map the episode-recording block below applies. Both
          // have to agree or a ruling is reconstructed for a proposal the agent
          // would never have logged.
          const absorbed = await absorbVerdicts(ctx.db, spec.id, record, ctx.now, {
            kinds: learnsFrom(spec),
            channel: spec.channel,
          });
          record = absorbed.record;
          if (absorbed.resolved > 0) {
            ctx.log(`${spec.id}: absorbed ${absorbed.resolved} new ruling(s)`);
          }
          if (absorbed.backfilled > 0) {
            ctx.log(`${spec.id}: recovered ${absorbed.backfilled} earlier ruling(s) from the queue`);
          }

          if (shouldForm(record)) {
            ctx.log(`${spec.id}: forming lessons from ${record.pendingVerdicts} ruling(s)`);
            const formed = await formLessons(ctx.claude, record, spec.name);
            if (formed) {
              record = formed;
              ctx.log(`${spec.id}: ${record.lessons.length} lesson(s) held`);
            }
          }

          learned = learningContext(record, HAS_AUDIENCE_DATA);
        } catch (err) {
          ctx.log(`${spec.id}: learning pass failed, drafting without it`, {
            error: err instanceof Error ? err.message : String(err),
          });
          record = null;
          learned = null;
        }
      }

      let result: StrategyResult | null = null;
      try {
        result = await draftForChannel(spec, ctx, history, learned);
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

      for (const idea of (result.growth_ideas ?? []).slice(0, 3)) {
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

      // --- learning: record what was proposed -----------------------------
      //
      // The episode key is `dedupeKey(spec.id, action)`, which is the exact
      // string the Chief-of-Staff stamps onto the approval row when it queues
      // one (chief-of-staff.ts:97). Recomputing it here rather than inventing a
      // handle is what lets a ruling that arrives days later be joined back to
      // the proposal that earned it — and it already carries a content hash, so
      // two differently-worded ideas stay two episodes instead of collapsing
      // into one.
      //
      // Only proposals that can BE ruled on are worth recording. A draft that
      // classifies routine is executed without anyone deciding anything, so it
      // would sit unresolved forever and drag the ring down with it.
      if (spec.learning && record) {
        try {
          const kinds = learnsFrom(spec);
          const episodes = episodesFor(
            proposals
              .filter((action) => kinds[action.type])
              .map((action) => ({
                key: dedupeKey(spec.id, action),
                kind: kinds[action.type]!,
                summary: String(action.payload["title"] ?? action.summary),
                features: buildFeatures(action.payload, spec.channel),
              })),
            ctx.now
          );
          const next = demote(recordEpisodes(record, episodes, ctx.now), ctx.now);
          await writeLearning(ctx.db, spec.id, next);
        } catch (err) {
          ctx.log(`${spec.id}: could not save the learning record`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
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

      // Direct posting takes precedence over the partner queue the moment it is
      // actually live. Both branches are kept because the queue is the honest
      // fallback while LinkedIn's Community Management API app is under review:
      // the alternative is an agent that cannot publish at all until an outside
      // approval lands, and drafts that pile up nowhere.
      const linkedInDirect =
        spec.route === "linkedin-partner-queue" &&
        linkedInDirectConnector.status(ctx.env).active;

      if (spec.route === "linkedin-partner-queue" && !linkedInDirect) {
        // We do not post to LinkedIn ourselves. The strategist drafts, the
        // outside partner agent collects and publishes. If the partner is not
        // wired up yet, the draft still lands in the queue and waits.
        //
        // Handing the draft over IS this channel's publish step, whether or not
        // the partner is switched on yet, so the bookkeeping is the same on
        // both sides of that branch: stamp the draft as handed over, consume
        // the slot that called for it. Only the outcome differs, because only
        // one of the two has actually reached LinkedIn.
        //
        // Doing it on one side only is what filled the queue with a single post
        // repeated hourly. The partner is not wired up, so every run took the
        // early return: the draft was never stamped, so the next run found the
        // same ready draft; the slot was never consumed, so it was still due;
        // and the handover reports `blocked_inactive`, which readChannelHistory
        // does not count, so the minimum-gap check never engaged either. Three
        // guards, all bypassed by the same early return.
        const live =
          flag(ctx.env.LINKEDIN_INTEGRATION_ENABLED) && Boolean(ctx.env.LINKEDIN_PARTNER_TOKEN);

        const { item: queued, duplicate } = await enqueueForPartner(ctx.db, {
          text,
          approvalRef: action.approvedContentRef,
          pillar: String(action.payload["pillar"] ?? ""),
          format: String(action.payload["format"] ?? ""),
          // The draft id, so a second handover of the same draft is recognised
          // as the same work even if the copy was touched in between.
          sourceKey: draftId || undefined,
        });

        await stampPublished(queued.id);
        const usedSlot = action.payload["scheduledSlot"];
        if (typeof usedSlot === "string") {
          const currentPlan = await ensureWeeklyPlan(ctx.db, spec.schedule, ctx.now);
          await markSlotConsumed(ctx.db, spec.schedule, usedSlot, currentPlan);
        }

        if (!live) {
          return {
            outcome: "blocked_inactive",
            externalRef: queued.id,
            detail: {
              note: duplicate
                ? "This draft was already waiting in the LinkedIn queue, so nothing was added. It publishes as soon as the partner integration is switched on."
                : "LinkedIn draft queued. It publishes as soon as the partner integration is switched on.",
              draftId,
              duplicate,
              waitingOn: ["LINKEDIN_INTEGRATION_ENABLED", "LINKEDIN_PARTNER_TOKEN"],
            },
          };
        }

        return {
          outcome: "executed",
          externalRef: queued.id,
          detail: {
            note: duplicate
              ? "Already waiting in the LinkedIn partner queue; nothing was added."
              : "Queued for the LinkedIn partner agent to publish.",
            draftId,
            duplicate,
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
