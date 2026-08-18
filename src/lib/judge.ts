// Narrow, structured judgement calls.
//
// The autonomy rules are deterministic wherever a deterministic test is
// honest. Some are not: "is this comment criticism or praise" cannot be decided
// by a keyword list without being wrong in exactly the cases that matter. Those
// go through here, and — this is the important part — a low-confidence or
// failed judgement resolves toward approval, never toward acting.

import type { Judge } from "../core/types.js";
import { Claude, type Effort } from "./claude.js";

export interface JudgeOptions {
  effort?: Effort;
  /** Below this, the caller should treat the answer as "unsure". */
  confidenceFloor?: number;
}

export function createJudge(claude: Claude, options: JudgeOptions = {}): Judge {
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
 * A judge that refuses to guess. Used when no API key is configured, so the
 * system degrades into "queue it for a human" rather than into "act blindly".
 */
export const unavailableJudge: Judge = {
  async categorize() {
    throw new Error("Judge unavailable: ANTHROPIC_API_KEY is not set");
  },
};
