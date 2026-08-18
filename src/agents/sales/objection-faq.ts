// Objection / FAQ Agent — Sales Management.
//
// Doc: maintains and uses a set of answers to recurring prospect questions, so
// replies stay consistent across the whole pipeline.
//
//   Routine        answering known questions in already-approved language
//   Needs approval a new or ambiguous question type it hasn't handled before
//
// "Already-approved language" is taken literally: a routine answer is the
// stored answer from FAQ_LIBRARY, sent as written. The agent does not
// paraphrase it, because a paraphrase is new language nobody approved. When no
// entry matches, or the match is not confident, the question is queued along
// with a drafted answer for you to approve or edit — which is how the library
// grows.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { FAQ_LIBRARY, findFaqEntry } from "../../core/config.js";

const MATCH_CONFIDENCE_FLOOR = 0.8;

export const objectionFaqAgent: AgentDefinition = {
  id: "objection_faq",
  name: "Objection / FAQ Agent",
  batch: "sales_management",
  description:
    "Maintains and uses approved answers to recurring prospect questions, so replies stay consistent across the pipeline.",
  effort: "high",
  cadence: "manual",
  approvedChannels: ["internal"],

  routineRules: [
    {
      id: "objection_faq.known_question_approved_language",
      describe: "Answering a known question in already-approved language.",
      classification: "routine",
      test: (action) => {
        if (action.type !== "faq_answer") return null;
        const faqId = String(action.payload["faqId"] ?? "");
        const entry = FAQ_LIBRARY.find((item) => item.id === faqId);
        if (!entry) return null;
        if (Number(action.payload["matchConfidence"] ?? 0) < MATCH_CONFIDENCE_FLOOR) return null;
        // The answer must be the approved text, unchanged.
        if (String(action.payload["answer"] ?? "") !== entry.approvedAnswer) return null;
        return `Question matches ${entry.id} and the reply is the approved answer, word for word.`;
      },
    },
  ],

  approvalRules: [
    {
      id: "objection_faq.new_or_ambiguous_question",
      describe: "A new or ambiguous question type it has not handled before.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "faq_answer" && action.type !== "faq_entry_add") return null;
        const faqId = action.payload["faqId"];
        if (!faqId) return "No approved answer covers this question yet.";
        const confidence = Number(action.payload["matchConfidence"] ?? 0);
        return confidence < MATCH_CONFIDENCE_FLOOR
          ? `Matched ${String(faqId)} at only ${(confidence * 100).toFixed(0)}% confidence, which is not confident enough to answer from the library.`
          : null;
      },
    },
    {
      id: "objection_faq.rewritten_answer",
      describe: "An answer that departs from the approved wording.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "faq_answer") return null;
        const entry = FAQ_LIBRARY.find((item) => item.id === action.payload["faqId"]);
        if (!entry) return null;
        return String(action.payload["answer"] ?? "") === entry.approvedAnswer
          ? null
          : "The reply is not the approved wording. Rewritten answers are new language, so they wait for you.";
      },
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    // Event-driven: a question arrives from the pipeline, a form, or the API.
    const question = typeof ctx.input?.["question"] === "string" ? (ctx.input["question"] as string) : null;
    if (!question) {
      ctx.log("objection_faq: no question to answer this run");
      return [];
    }

    const askedBy = typeof ctx.input?.["prospectId"] === "string" ? (ctx.input["prospectId"] as string) : undefined;
    const cued = findFaqEntry(question);

    // The cue match is a first pass. The model confirms whether the stored
    // answer actually answers what was asked, and how sure it is.
    let faqId: string | null = null;
    let confidence = 0;
    let reason = "";

    if (cued) {
      const verdict = await ctx.judge.categorize<"answers_it" | "related_but_different" | "does_not_answer_it">({
        text: `Prospect asked: ${question}\n\nStored question: ${cued.question}\nStored answer: ${cued.approvedAnswer}`,
        categories: ["answers_it", "related_but_different", "does_not_answer_it"],
        instruction:
          "Decide whether the stored answer actually answers what the prospect asked. " +
          "Related-but-different means it touches the same subject without answering the question.",
      });
      reason = verdict.reason;
      if (verdict.category === "answers_it") {
        faqId = cued.id;
        confidence = verdict.confidence;
      } else {
        confidence = 0;
      }
    }

    if (faqId && confidence >= MATCH_CONFIDENCE_FLOOR) {
      const entry = FAQ_LIBRARY.find((item) => item.id === faqId)!;
      return [
        {
          type: "faq_answer",
          summary: `Answer "${question.slice(0, 60)}" from ${entry.id}`,
          target: askedBy,
          payload: {
            question,
            faqId: entry.id,
            answer: entry.approvedAnswer,
            matchConfidence: confidence,
            matchReason: reason,
            prospectId: askedBy ?? null,
          },
          rationale: `Known question, answered in the approved language for ${entry.id}.`,
          dedupeKey: `faq:${entry.id}:${askedBy ?? question.slice(0, 40)}`,
        },
      ];
    }

    // Nothing in the library covers it. Draft a candidate answer and a proposed
    // library entry, and put both in front of you.
    const draft = await ctx.claude.complete({
      system:
        "You draft answers to prospect questions for a consulting business that runs operational " +
        "diagnostics. Answer plainly and specifically, in two or three sentences. Never promise a " +
        "price, a timeline or an outcome that has not been stated. No em dashes. Output only the answer.",
      user:
        `Prospect asked: ${question}\n\n` +
        `Existing approved answers, for consistency of tone:\n` +
        FAQ_LIBRARY.map((entry) => `- ${entry.question} -> ${entry.approvedAnswer}`).join("\n"),
      effort: objectionFaqAgent.effort,
      maxTokens: 600,
    });

    return [
      {
        type: "faq_answer",
        summary: `New question type: "${question.slice(0, 60)}"`,
        target: askedBy,
        payload: {
          question,
          faqId: null,
          answer: draft.text.trim(),
          matchConfidence: confidence,
          matchReason: reason || "No entry in the library covers this question.",
          prospectId: askedBy ?? null,
          proposedLibraryEntry: {
            question,
            approvedAnswer: draft.text.trim(),
          },
        },
        rationale:
          "This question is not in the approved library. A draft answer is attached. Approving it " +
          "sends the answer; adding it to FAQ_LIBRARY in src/core/config.ts makes it routine next time.",
        dedupeKey: `faq:new:${question.slice(0, 60)}`,
      },
    ];
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    // Delivery: this agent supplies the answer, it does not contact anyone.
    // Whatever is talking to the prospect (the pipeline, a form, you) reads it
    // from here. Contacting a prospect directly is a client-facing action and
    // belongs to a different rule set.
    await ctx.db.writeMemory({
      key: `faq.answered.${action.payload["prospectId"] ?? crypto.randomUUID()}`,
      scope: "objection_faq",
      kind: "decision",
      content: `Q: ${action.payload["question"]}\nA: ${action.payload["answer"]}`,
      detail: action.payload,
      salience: 5,
      source_agent: "objection_faq",
      tags: ["faq"],
    });

    return {
      outcome: "executed",
      detail: {
        faqId: action.payload["faqId"],
        answer: action.payload["answer"],
        note: "Answer prepared in approved language and recorded. Delivery to the prospect stays with the pipeline.",
      },
    };
  },
};
