// Content Agent — Marketing.
//
// Architecture doc: drafts the copy that the LinkedIn, Facebook and X agents
// publish, so all three channels keep one consistent voice instead of drifting
// apart. Built against the voice profile.
//
//   Routine        drafting within established topics, formats and voice
//   Needs approval a new content pillar or campaign direction
//
// The rules below are the enforcement of exactly that: a draft inside
// CONTENT_PILLARS and APPROVED_FORMATS is routine, a pillar that is not on the
// list is queued, and copy that fails the voice check does not reach a channel
// agent at all.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import {
  APPROVED_FORMATS,
  CONTENT_PILLARS,
  type ContentFormat,
  type ContentPillar,
} from "../../core/config.js";
import { state, type ContentDraft } from "../../core/state.js";
import { DEFAULT_VOICE, scanForTells, softenTells } from "../../core/voice.js";

import { MODELS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";

const MODEL = MODELS.reasoning;

/** How many ready drafts to keep on the shelf before drafting more. */
const TARGET_READY_DRAFTS = 4;
const DRAFTS_PER_RUN = 2;

const SYSTEM = `You write short public posts for Velvex.

${BUSINESS_CONTEXT}

${DEFAULT_VOICE.guide}

You will be given a topic pillar and a format. Write one post. Output the post text only, with no title, no framing, no notes about what you wrote.`;

function isApprovedPillar(value: unknown): value is ContentPillar {
  return typeof value === "string" && (CONTENT_PILLARS as readonly string[]).includes(value);
}

function isApprovedFormat(value: unknown): value is ContentFormat {
  return typeof value === "string" && (APPROVED_FORMATS as readonly string[]).includes(value);
}

/** Rotates pillars by what has been used least recently. */
function chooseWork(drafts: ContentDraft[]): Array<{ pillar: ContentPillar; format: ContentFormat }> {
  const lastUsed = new Map<string, number>();
  for (const draft of drafts) {
    const at = new Date(draft.createdAt).getTime();
    if (!lastUsed.has(draft.pillar) || at > lastUsed.get(draft.pillar)!) {
      lastUsed.set(draft.pillar, at);
    }
  }

  const ordered = [...CONTENT_PILLARS].sort(
    (a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0)
  );

  const formats: ContentFormat[] = ["short-post", "case-note", "long-post", "question-post"];
  return ordered.slice(0, DRAFTS_PER_RUN).map((pillar, index) => ({
    pillar,
    format: formats[index % formats.length]!,
  }));
}

export const contentAgent: AgentDefinition = {
  id: "content",
  name: "Content Agent",
  batch: "marketing",
  description:
    "Drafts the copy the channel agents publish, so all channels keep one voice instead of drifting apart.",
  // Public writing in the business's own voice, at two drafts a day. The most
  // visible thing the system produces when it is wrong, and low enough volume
  // that depth here costs pennies.
  model: MODEL,
  effort: "xhigh",
  cadence: "daily",
  approvedChannels: ["linkedin", "facebook", "x", "internal"],

  routineRules: [
    {
      id: "content.established_pillar_and_format",
      describe: "Drafting inside an established pillar, format and voice.",
      classification: "routine",
      test: (action) => {
        if (action.type !== "draft_content") return null;
        const { pillar, format, voiceClean } = action.payload;
        if (!isApprovedPillar(pillar)) return null;
        if (!isApprovedFormat(format)) return null;
        if (voiceClean !== true) return null;
        return `Pillar "${pillar}" and format "${format}" are already approved, and the draft passed the voice check.`;
      },
    },
  ],

  approvalRules: [
    {
      id: "content.new_pillar",
      describe: "A topic outside the established pillars is a new pillar.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "draft_content" && action.type !== "new_content_pillar") return null;
        const pillar = action.payload["pillar"];
        return isApprovedPillar(pillar)
          ? null
          : `"${String(pillar)}" is not one of the established content pillars.`;
      },
    },
    {
      id: "content.new_format",
      describe: "A format nobody has signed off on is a campaign decision, not a draft.",
      classification: "needs_approval",
      risk: "low",
      test: (action) => {
        if (action.type !== "draft_content") return null;
        const format = action.payload["format"];
        return isApprovedFormat(format) ? null : `"${String(format)}" is not an approved format.`;
      },
    },
    {
      id: "content.voice_check_failed",
      describe: "Copy carrying AI tells does not go out in the owner's voice.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "draft_content") return null;
        const violations = action.payload["voiceViolations"];
        return Array.isArray(violations) && violations.length > 0
          ? `Draft still reads as generated after one revision pass: ${violations
              .map((v) => (v as { id: string }).id)
              .join(", ")}.`
          : null;
      },
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const drafts = await state.contentQueue(ctx.db);
    const ready = drafts.filter((draft) => draft.status === "ready").length;
    if (ready >= TARGET_READY_DRAFTS) {
      ctx.log(`content: ${ready} drafts ready, shelf is full`);
      return [];
    }

    const recent = drafts
      .slice(0, 8)
      .map((draft) => `- (${draft.pillar}/${draft.format}) ${draft.text.slice(0, 120)}`)
      .join("\n");

    const proposals: ProposedAction[] = [];

    for (const work of chooseWork(drafts)) {
      const result = await ctx.claude.complete({
        system: SYSTEM,
        user:
          `Pillar: ${work.pillar}\nFormat: ${work.format}\n\n` +
          `Recent posts, so you do not repeat them:\n${recent || "(nothing yet)"}\n\n` +
          `Write the post.`,
        model: MODEL,
        effort: contentAgent.effort,
        maxTokens: 2000,
      });

      let text = result.text.trim();
      let violations = scanForTells(text);

      // One repair pass. The deterministic softener handles dashes and spacing;
      // anything structural goes back to the model once, and if it still reads
      // as generated the draft is queued for a human instead of shipped.
      if (violations.length > 0) {
        text = softenTells(text);
        violations = scanForTells(text);
      }
      if (violations.length > 0) {
        const repair = await ctx.claude.complete({
          system: SYSTEM,
          user:
            `This draft broke the voice rules: ${violations
              .map((violation) => `${violation.id} (${violation.detail})`)
              .join("; ")}.\n\nRewrite it so it does not. Same point, same length.\n\n${text}`,
          model: MODEL,
          effort: contentAgent.effort,
          maxTokens: 2000,
        });
        text = softenTells(repair.text.trim());
        violations = scanForTells(text);
      }

      proposals.push({
        type: "draft_content",
        summary: `Draft (${work.pillar}, ${work.format}): ${text.slice(0, 70)}...`,
        channel: "internal",
        payload: {
          pillar: work.pillar,
          format: work.format,
          text,
          voiceClean: violations.length === 0,
          voiceViolations: violations,
        },
        rationale:
          violations.length === 0
            ? "Inside an established pillar and format, and it passes the voice check."
            : "Drafted, but it still carries tells the voice profile bans. Your call.",
        dedupeKey: `draft:${work.pillar}:${work.format}:${ctx.now.toISOString().slice(0, 10)}`,
      });
    }

    return proposals;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type !== "draft_content") {
      return { outcome: "no_op", detail: { note: `Nothing to do for "${action.type}".` } };
    }

    const drafts = await state.contentQueue(ctx.db);
    const draft: ContentDraft = {
      id: crypto.randomUUID(),
      pillar: String(action.payload["pillar"]),
      format: String(action.payload["format"]),
      text: String(action.payload["text"]),
      createdAt: ctx.now.toISOString(),
      withinApprovedScope: action.payload["voiceClean"] === true,
      approvalRef: action.approvedContentRef,
      publishedOn: [],
      status: action.payload["voiceClean"] === true ? "ready" : "needs_revision",
    };

    drafts.unshift(draft);
    await state.saveContentQueue(ctx.db, drafts);

    return {
      outcome: "executed",
      externalRef: draft.id,
      detail: { draftId: draft.id, pillar: draft.pillar, format: draft.format, status: draft.status },
    };
  },
};
