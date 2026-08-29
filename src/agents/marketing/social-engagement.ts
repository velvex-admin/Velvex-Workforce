// Social Engagement Agent — Marketing.
//
// Doc: reads and responds to comments and DMs across LinkedIn, Facebook and X —
// questions, praise, complaints and hostile comments alike. Distinct from the
// VX-04 voice line, which is phone and email only.
//
//   Routine        replies to praise and simple factual questions
//   Needs approval any reply to criticism, an insult or a public complaint,
//                  until its judgment there is proven out
//
// This is one of the two agents the doc draws tighter than its batch-mates, and
// the tightening is real here: the category call goes through the model, and a
// call made below ENGAGEMENT_CONFIDENCE_FLOOR is treated as not-routine even
// when the label itself came back "praise". Being unsure is not permission.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { Channel, ExecutionResult, ProposedAction } from "../../core/types.js";
import {
  ENGAGEMENT_CATEGORIES,
  ENGAGEMENT_CONFIDENCE_FLOOR,
  ROUTINE_ENGAGEMENT,
  type EngagementCategory,
} from "../../core/config.js";
import { DEFAULT_VOICE, scanForTells, softenTells } from "../../core/voice.js";
import { facebookConnector } from "../../connectors/facebook.js";
import { xConnector } from "../../connectors/x.js";
import { enqueueForPartner, takeInbound } from "../../connectors/linkedin.js";
import { spamTriage } from "../../lib/judge.js";
import { getConnector } from "../../connectors/registry.js";
import {
  ConnectorInactiveError,
  ConnectorRequestError,
  type Connector,
  type InboundMessage,
} from "../../connectors/types.js";
import { MODELS, SHORT_ANSWER_MAX_TOKENS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";

const MODEL = MODELS.reasoning;

const SYSTEM = `You reply to public comments and direct messages on behalf of Velvex.

${BUSINESS_CONTEXT}

${DEFAULT_VOICE.guide}

Replies specifically:
- Short. One or two sentences is usually right, three at most.
- Answer the actual question. Do not upsell, do not redirect to a call unless they asked how to start.
- To praise: thank them like a person would, once, without gushing and without turning it into marketing.
- Never promise a timeline, a price or an outcome. If that is what they are asking, say you will follow up properly rather than answering in a comment.

Output only the reply text.`;

const CATEGORY_INSTRUCTION =
  "Classify this inbound social message by what it is, from the point of view of the business " +
  "it was sent to. Criticism, insults and public complaints must never be labelled praise or a " +
  "simple question: if it carries any complaint, sarcasm, or challenge to the business, it is not simple.";

interface Candidate {
  message: InboundMessage;
  category: EngagementCategory;
  confidence: number;
  reason: string;
}

/** A channel we hold credentials for but cannot currently read. */
interface UnreadableChannel {
  channel: Channel;
  status: number;
  reason: string;
}

/**
 * Statuses that mean "the credentials are fine, this plan may not read here".
 * X returns 402 credits-depleted on the free tier, because posting is included
 * and reading mentions is not. That is a billing state, not a fault, and it
 * must not take down the channels that are working.
 */
function accessReason(status: number): string | null {
  if (status === 401) return "credentials were rejected";
  if (status === 402) return "read access is not included in the current API plan";
  if (status === 403) return "this app is not permitted to read here";
  return null;
}

async function gather(
  ctx: RunContext
): Promise<{ messages: InboundMessage[]; unreadable: UnreadableChannel[] }> {
  const messages: InboundMessage[] = [];
  const unreadable: UnreadableChannel[] = [];
  const since = new Date(ctx.now.getTime() - 3 * 86400_000).toISOString();

  for (const connector of [facebookConnector, xConnector] as Connector[]) {
    try {
      messages.push(...(await connector.fetchInbound(ctx.env, since)));
    } catch (err) {
      if (err instanceof ConnectorInactiveError) {
        ctx.log(`social_engagement: ${connector.channel} inactive, waiting on ${err.missing.join(", ")}`);
        continue;
      }
      if (err instanceof ConnectorRequestError) {
        const reason = accessReason(err.status);
        if (reason) {
          // Skip this channel and carry on. Failing the whole run here would
          // hide inbound messages on the channels that are working.
          ctx.log(`social_engagement: cannot read ${connector.channel} — ${reason} (HTTP ${err.status})`);
          unreadable.push({ channel: connector.channel, status: err.status, reason });
          continue;
        }
      }
      throw err;
    }
  }

  // LinkedIn arrives through the partner integration rather than an API we call.
  messages.push(...(await takeInbound(ctx.db)));

  // Event-driven runs carry a single message in.
  const injected = ctx.input?.["message"];
  if (injected && typeof injected === "object") messages.push(injected as InboundMessage);

  return { messages, unreadable };
}

export const socialEngagementAgent: AgentDefinition = {
  id: "social_engagement",
  name: "Social Engagement Agent",
  batch: "marketing",
  description:
    "Reads and responds to comments and DMs across LinkedIn, Facebook and X. Praise and simple questions are answered; anything critical waits for you.",
  // Public replies, written in the business's voice under a judgement call.
  // The classification runs a tier down through the judge, and obvious spam is
  // dropped a tier below that before either is paid for.
  model: MODEL,
  effort: "xhigh",
  cadence: "hourly",
  approvedChannels: ["linkedin", "facebook", "x"],

  routineRules: [
    {
      id: "social_engagement.praise_or_simple_question",
      describe: "Replies to praise and simple factual questions, when the read is confident.",
      classification: "routine",
      test: (action) => {
        if (action.type !== "reply_public" && action.type !== "reply_dm") return null;
        const category = action.payload["category"] as EngagementCategory | undefined;
        const confidence = Number(action.payload["confidence"] ?? 0);
        if (!category || !ROUTINE_ENGAGEMENT.includes(category)) return null;
        if (confidence < ENGAGEMENT_CONFIDENCE_FLOOR) return null;
        if (action.payload["voiceClean"] !== true) return null;
        return `Message reads as ${category} at ${(confidence * 100).toFixed(0)}% confidence, which is inside the routine line.`;
      },
    },
  ],

  approvalRules: [
    {
      id: "social_engagement.criticism_insult_or_complaint",
      describe: "Any reply to criticism, an insult or a public complaint.",
      classification: "needs_approval",
      risk: "high",
      test: (action) => {
        const category = action.payload["category"] as EngagementCategory | undefined;
        if (!category) return null;
        return (["criticism", "insult", "public_complaint"] as EngagementCategory[]).includes(category)
          ? `Message reads as ${category}. Replies to criticism wait for you until this agent's judgement there is proven out.`
          : null;
      },
    },
    {
      id: "social_engagement.unsure",
      describe: "A category call the agent is not confident about.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "reply_public" && action.type !== "reply_dm") return null;
        const confidence = Number(action.payload["confidence"] ?? 0);
        return confidence < ENGAGEMENT_CONFIDENCE_FLOOR
          ? `Category read at only ${(confidence * 100).toFixed(0)}% confidence, under the ${(ENGAGEMENT_CONFIDENCE_FLOOR * 100).toFixed(0)}% floor. Being unsure is not permission to reply.`
          : null;
      },
    },
    {
      id: "social_engagement.sales_enquiry",
      describe: "A prospect asking to buy is a pipeline event, not a comment reply.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) =>
        action.payload["category"] === "sales_enquiry"
          ? "This is a sales enquiry. It belongs in the pipeline rather than in a public reply."
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const { messages, unreadable } = await gather(ctx);

    if (messages.length === 0) {
      if (unreadable.length > 0) {
        // Record it. A channel that has silently stopped being readable looks
        // exactly like a quiet channel, and the two need different responses.
        return unreadable.map((entry) => ({
          type: "observation" as const,
          summary: `Cannot read ${entry.channel}: ${entry.reason}`,
          channel: entry.channel,
          payload: { status: entry.status, reason: entry.reason },
          rationale:
            `Inbound messages on ${entry.channel} are not being seen. Credentials are present, ` +
            `so this is an access or plan question rather than a fault.`,
          dedupeKey: `unreadable:${entry.channel}:${entry.status}`,
        }));
      }
      ctx.log("social_engagement: nothing inbound");
      return [];
    }

    const handled = await ctx.db.readMemory({ keys: ["social.handled"], limit: 1 });
    const seen = new Set(
      Array.isArray(handled[0]?.detail?.["ids"]) ? (handled[0]!.detail!["ids"] as string[]) : []
    );

    const fresh = messages.filter((message) => !seen.has(message.id)).slice(0, 10);
    const candidates: Candidate[] = [];
    const dropped: InboundMessage[] = [];

    for (const message of fresh) {
      // Obvious spam is dropped on the fast tier before anything expensive
      // runs. This filter can only ever say "definitely spam"; anything else,
      // including an unsure answer or a failure, falls through to the real
      // judge. That asymmetry is what makes the saving safe.
      const triage = await spamTriage(ctx.claude, message.text);
      if (triage.isSpam) {
        dropped.push(message);
        continue;
      }

      const verdict = await ctx.judge.categorize<EngagementCategory>({
        text: message.text,
        categories: ENGAGEMENT_CATEGORIES,
        instruction: CATEGORY_INSTRUCTION,
      });
      candidates.push({
        message,
        category: verdict.category,
        confidence: verdict.confidence,
        reason: verdict.reason,
      });
    }

    const proposals: ProposedAction[] = dropped.map((message) => ({
      type: "observation" as const,
      summary: `Ignored spam on ${message.channel}`,
      channel: message.channel,
      target: message.id,
      payload: { messageId: message.id, category: "spam", filteredOn: "fast-tier triage" },
      dedupeKey: `engagement:spam:${message.id}`,
    }));

    for (const candidate of candidates) {
      if (candidate.category === "spam") {
        proposals.push({
          type: "observation",
          summary: `Ignored spam on ${candidate.message.channel}`,
          channel: candidate.message.channel,
          target: candidate.message.id,
          payload: { messageId: candidate.message.id, category: candidate.category },
          dedupeKey: `engagement:spam:${candidate.message.id}`,
        });
        continue;
      }

      const draft = await ctx.claude.complete({
        system: SYSTEM,
        user:
          `Channel: ${candidate.message.channel}\n` +
          `This message reads as: ${candidate.category} (${candidate.reason})\n\n` +
          `Their message:\n"""\n${candidate.message.text}\n"""\n\nWrite the reply.`,
        model: MODEL,
        effort: socialEngagementAgent.effort,
        maxTokens: SHORT_ANSWER_MAX_TOKENS,
      });

      let text = softenTells(draft.text.trim());
      const violations = scanForTells(text);

      proposals.push({
        type: candidate.message.kind === "dm" ? "reply_dm" : "reply_public",
        summary: `Reply on ${candidate.message.channel} to ${candidate.category}: ${text.slice(0, 60)}...`,
        channel: candidate.message.channel,
        target: candidate.message.id,
        payload: {
          messageId: candidate.message.id,
          channel: candidate.message.channel,
          kind: candidate.message.kind,
          inbound: candidate.message.text,
          category: candidate.category,
          confidence: candidate.confidence,
          categoryReason: candidate.reason,
          reply: text,
          voiceClean: violations.length === 0,
          voiceViolations: violations,
        },
        rationale:
          `Inbound ${candidate.category} at ${(candidate.confidence * 100).toFixed(0)}% confidence. ` +
          candidate.reason,
        reversible: true,
        dedupeKey: `engagement:${candidate.message.id}`,
      });
    }

    return proposals;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    const markHandled = async (id: string) => {
      const rows = await ctx.db.readMemory({ keys: ["social.handled"], limit: 1 });
      const ids = Array.isArray(rows[0]?.detail?.["ids"])
        ? (rows[0]!.detail!["ids"] as string[])
        : [];
      await ctx.db.writeMemory({
        key: "social.handled",
        scope: "social_engagement",
        kind: "entity",
        content: `${ids.length + 1} inbound messages handled`,
        detail: { ids: [id, ...ids].slice(0, 500) },
        salience: 3,
        source_agent: "social_engagement",
        tags: ["engagement"],
      });
    };

    if (action.type === "observation") {
      if (action.target) await markHandled(action.target);
      return { outcome: "observed", detail: action.payload };
    }

    const messageId = String(action.payload["messageId"]);
    const channel = String(action.payload["channel"]);
    const reply = String(action.payload["reply"]);
    const kind = action.payload["kind"] === "dm" ? "dm" : "comment";

    // LinkedIn has no connector on our side: the external agent posts. The
    // reply goes into the partner queue and is collected like any other item.
    if (channel === "linkedin") {
      const queued = await enqueueForPartner(ctx.db, {
        text: reply,
        approvalRef: action.approvedContentRef,
      });
      await markHandled(messageId);
      return {
        outcome: "executed",
        externalRef: queued.id,
        detail: {
          note: "Reply queued for the external LinkedIn agent to post.",
          inReplyTo: messageId,
        },
      };
    }

    try {
      const connector = getConnector(channel as "facebook" | "x");
      const result = await connector.reply(
        { inReplyTo: messageId, text: reply, kind },
        ctx.env
      );
      await markHandled(messageId);
      return { outcome: "executed", externalRef: result.externalRef, detail: { channel, kind } };
    } catch (err) {
      if (err instanceof ConnectorInactiveError) {
        return {
          outcome: "blocked_inactive",
          detail: {
            channel,
            waitingOn: err.missing,
            reply,
            note: "Reply written and held. It sends as soon as credentials are supplied.",
          },
        };
      }
      return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  },
};
