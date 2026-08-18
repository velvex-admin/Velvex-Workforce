// Every agent's reasoning goes through here.
//
// One model for the whole system — Claude Opus 5, as the architecture doc
// specifies. What varies per agent is `effort`, not the model: an agent that
// only aggregates numbers does not need the same depth as one drafting public
// copy or weighing a strategy shift. See docs/MODEL-CHOICES.md.

import Anthropic from "@anthropic-ai/sdk";
import { requireSecret, type Env } from "../env.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CompleteArgs {
  system: string;
  user: string;
  effort?: Effort;
  maxTokens?: number;
  /** When set, the reply is constrained to this JSON Schema and parsed. */
  schema?: Record<string, unknown>;
  /** Prior turns, oldest first. Used by the Chief-of-Staff for continuity. */
  history?: Anthropic.MessageParam[];
}

export interface CompleteResult<T = string> {
  text: string;
  parsed?: T;
  model: string;
  effort: Effort;
  usage: Record<string, unknown>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly original?: unknown
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * Request and response shapes for API features the pinned SDK version does not
 * type yet: adaptive thinking, output_config.effort, and stop_details. The API
 * accepts them and the SDK passes the body through untouched, so these two
 * declarations plus one cast at the call site are the whole workaround. When
 * the SDK catches up, delete both and the casts with them.
 */
interface CurrentMessageParams {
  model: string;
  max_tokens: number;
  thinking: { type: "adaptive" };
  output_config: {
    effort: Effort;
    format?: { type: "json_schema"; schema: Record<string, unknown> };
  };
  system: string;
  messages: Anthropic.MessageParam[];
}

interface CurrentMessage extends Anthropic.Message {
  stop_details?: { type: string; category?: string | null; explanation?: string } | null;
}

export class Claude {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(env: Env) {
    this.client = new Anthropic({ apiKey: requireSecret(env, "ANTHROPIC_API_KEY") });
    this.model = env.MODEL_ID || "claude-opus-5";
  }

  async complete<T = string>(args: CompleteArgs): Promise<CompleteResult<T>> {
    const effort: Effort = args.effort ?? "high";

    try {
      const params: CurrentMessageParams = {
        model: this.model,
        max_tokens: args.maxTokens ?? 16000,
        // Adaptive thinking: Claude decides how much reasoning each call needs.
        thinking: { type: "adaptive" },
        output_config: {
          effort,
          ...(args.schema
            ? { format: { type: "json_schema" as const, schema: args.schema } }
            : {}),
        },
        system: args.system,
        messages: [...(args.history ?? []), { role: "user", content: args.user }],
      };

      const response = (await this.client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming
      )) as CurrentMessage;

      if (response.stop_reason === "refusal") {
        throw new ModelError(
          `Model declined the request (${response.stop_details?.category ?? "unspecified"})`
        );
      }

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
      }

      let parsed: T | undefined;
      if (args.schema) {
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          throw new ModelError(`Expected JSON matching the schema, got: ${text.slice(0, 200)}`);
        }
      }

      return {
        text,
        parsed,
        model: this.model,
        effort,
        usage: response.usage as unknown as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw new ModelError(
        `Claude call failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
}
