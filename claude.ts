// Every agent's reasoning goes through here.
//
// The model is chosen per agent, not globally: see src/core/models.ts for the
// three tiers and docs/MODEL-CHOICES.md for why each agent sits where it does.
// A call may also override its agent's model for one specific job, which is how
// the SEO agent writes alt text on Haiku while writing meta descriptions on
// Sonnet.
//
// Model capabilities differ, and getting that wrong is a 400 rather than a
// degradation: Haiku 4.5 takes neither adaptive thinking nor an effort setting.
// buildRequest() is the single place that knows this, and it is pure so the
// behaviour is tested rather than hoped for.

import Anthropic from "@anthropic-ai/sdk";
import { requireSecret, type Env } from "../env.js";
import {
  capabilitiesFor,
  estimateCostUsd,
  resolveTiers,
  type ModelTier,
  type TokenUsage,
} from "../core/models.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CompleteArgs {
  system: string;
  user: string;
  /** Defaults to the calling agent's model, which the runner passes in. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** When set, the reply is constrained to this JSON Schema and parsed. */
  schema?: Record<string, unknown>;
  history?: Anthropic.MessageParam[];
}

export interface CompleteResult<T = string> {
  text: string;
  parsed?: T;
  model: string;
  effort: Effort | null;
  usage: TokenUsage;
  /** Rough USD for this call. Written onto the report so spend stays visible. */
  costUsd: number;
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
 * Request shapes for API features the pinned SDK version does not type yet:
 * adaptive thinking, output_config.effort, and stop_details. The API accepts
 * them and the SDK passes the body through untouched. When the SDK catches up,
 * delete these and the casts with them.
 */
export interface BuiltRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  thinking?: { type: "adaptive" };
  output_config?: {
    effort?: Effort;
    format?: { type: "json_schema"; schema: Record<string, unknown> };
  };
}

interface CurrentMessage extends Anthropic.Message {
  stop_details?: { type: string; category?: string | null; explanation?: string } | null;
}

/**
 * Build the request body for one call, respecting what the chosen model
 * actually supports. Pure, and exported for the tests.
 */
export function buildRequest(args: {
  model: string;
  system: string;
  user: string;
  effort?: Effort;
  maxTokens?: number;
  schema?: Record<string, unknown>;
  history?: Anthropic.MessageParam[];
}): BuiltRequest {
  const capabilities = capabilitiesFor(args.model);

  const request: BuiltRequest = {
    model: args.model,
    max_tokens: args.maxTokens ?? 16000,
    system: args.system,
    messages: [...(args.history ?? []), { role: "user", content: args.user }],
  };

  // Adaptive thinking and effort exist only on the current generation. Sending
  // either to Haiku 4.5 is rejected outright, so they are simply left off.
  if (capabilities.adaptiveThinking) {
    request.thinking = { type: "adaptive" };
  }

  const outputConfig: NonNullable<BuiltRequest["output_config"]> = {};
  if (capabilities.effort && args.effort) outputConfig.effort = args.effort;
  if (args.schema) outputConfig.format = { type: "json_schema", schema: args.schema };
  if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;

  return request;
}

export class Claude {
  private readonly client: Anthropic;
  private readonly tiers: Record<ModelTier, string>;
  private readonly fallbackModel: string;

  /** Running totals for this Worker invocation, so a run can report its cost. */
  spentUsd = 0;
  callCount = 0;

  constructor(env: Env) {
    this.client = new Anthropic({ apiKey: requireSecret(env, "ANTHROPIC_API_KEY") });
    this.tiers = resolveTiers(env);
    // Used only when a caller forgets to name one; agents always pass theirs.
    this.fallbackModel = this.tiers.balanced;
  }

  modelFor(tier: ModelTier): string {
    return this.tiers[tier];
  }

  async complete<T = string>(args: CompleteArgs): Promise<CompleteResult<T>> {
    const model = args.model ?? this.fallbackModel;
    const capabilities = capabilitiesFor(model);
    const effort = capabilities.effort ? (args.effort ?? "high") : null;

    const request = buildRequest({
      model,
      system: args.system,
      user: args.user,
      maxTokens: args.maxTokens,
      schema: args.schema,
      history: args.history,
      ...(effort ? { effort } : {}),
    });

    try {
      const response = (await this.client.messages.create(
        request as unknown as Anthropic.MessageCreateParamsNonStreaming
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

      const usage = response.usage as unknown as TokenUsage;
      const costUsd = estimateCostUsd(model, usage);
      this.spentUsd = Math.round((this.spentUsd + costUsd) * 1_000_000) / 1_000_000;
      this.callCount += 1;

      return {
        text,
        parsed,
        model,
        effort,
        usage,
        costUsd,
      };
    } catch (err) {
      if (err instanceof ModelError) throw err;
      throw new ModelError(
        `Claude call failed on ${model}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
}
