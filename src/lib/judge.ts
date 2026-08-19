// Narrow, structured judgement calls.
//
// The autonomy rules are deterministic wherever a deterministic test is honest.
// Some are not: "is this comment criticism or praise" cannot be decided by a
// keyword list without being wrong in exactly the cases that matter.
//
// These calls run on the balanced tier rather than the reasoning tier. They are
// short, they answer one question, and the safety here comes from the
// confidence floor rather than from model depth: a low-confidence or failed
// judgement resolves toward approval, never toward acting.

import type { Judge } from "../core/types.js";
import { Claude, type Effort } from "./claude.js";

export interface JudgeOptions {
  model?: string;
  effort?: Effort;
}

export function createJudge(claude: Claude, options: JudgeOptions = {}): Judge {
  const model = options.model ?? claude.modelFor("balanced");
  const effort: Effort = options.effort ?? "medium";

  return {
    async categorize<T extends string>(args: {
      text: string;
      categories: readonly T[];
      instruction: string;
    }) {
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["category", "confidence", "reason"],
        properties: {
          category: { type: "string", enum: [...args.categories] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", maxLength: 300 },
        },
      };

      const result = await claude.complete<{
        category: T;
        confidence: number;
        reason: string;
      }>({
        model,
        system:
          "You classify text for an internal business system. Answer only with the " +
          "requested JSON. Be conservative: when a message is ambiguous, or sits " +
          "between two categories, report the lower confidence rather than " +
          "picking decisively. Your confidence is used to decide whether a human " +
          "reviews the result.",
        user: `${args.instruction}\n\nCategories: ${args.categories.join(", ")}\n\nText:\n"""\n${args.text}\n"""`,
        effort,
        maxTokens: 1024,
        schema,
      });

      const parsed = result.parsed;
      if (!parsed) throw new Error("Judge returned no parseable result");
      return parsed;
    },
  };
}

/**
 * A cheap first pass over inbound social messages, on the fast tier.
 *
 * Its only job is dropping obvious spam before the real judge is paid for. It
 * can only ever say "this is definitely spam" at high confidence; every other
 * answer, including an unsure one, passes the message through untouched. The
 * expensive call is what decides anything that matters.
 */
export async function spamTriage(
  claude: Claude,
  text: string,
  confidenceFloor = 0.9
): Promise<{ isSpam: boolean; confidence: number }> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["spam", "confidence"],
    properties: {
      spam: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };

  try {
    const result = await claude.complete<{ spam: boolean; confidence: number }>({
      model: claude.modelFor("fast"),
      system:
        "You are a spam filter for a business's social media inbox. Spam means bulk " +
        "promotion, crypto or follower selling, unrelated link drops, or bot output. " +
        "A complaint, an insult, a blunt question and a badly written message are NOT " +
        "spam. When unsure, answer spam: false. Reply with JSON only.",
      user: text.slice(0, 2000),
      maxTokens: 256,
      schema,
    });

    const parsed = result.parsed;
    if (!parsed) return { isSpam: false, confidence: 0 };
    return {
      isSpam: parsed.spam && parsed.confidence >= confidenceFloor,
      confidence: parsed.confidence,
    };
  } catch {
    // The filter failing must never drop a message: pass it to the real judge.
    return { isSpam: false, confidence: 0 };
  }
}

/**
 * A judge that refuses to guess. Used when no API key is configured, so the
 * system degrades into "queue it for a human" rather than into "act blindly".
 */
export const unavailableJudge: Judge = {
  async categorize() {
    throw new Error("Judge unavailable: ANTHROPIC_API_KEY is not set");
  },
};
