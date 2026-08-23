// Which model each agent thinks with.
//
// Three tiers, chosen per agent by what the work actually is. The rule applied
// throughout: pay for depth where a wrong answer is expensive or public, and
// stop paying for it where the work is mechanical. Five agents make no model
// calls at all, and saying so plainly is cheaper than any tier.
//
// Per-agent assignments live on each agent definition; the reasoning behind
// each one is in docs/MODEL-CHOICES.md.

export const MODELS = {
  /** Judgement that is expensive to get wrong, or writing that goes out in public. */
  reasoning: "claude-opus-5",
  /** Competent reading and writing inside tight bounds, at a fraction of the cost. */
  balanced: "claude-sonnet-5",
  /** Mechanical, high-volume, low-stakes work. */
  fast: "claude-haiku-4-5",
} as const;

export type ModelTier = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelTier];

/**
 * `null` means the agent makes no model calls at all. Four of them are
 * deterministic by nature (timing, threshold checks, stall arithmetic) and one
 * is an external build. Giving them a model would imply a cost that does not
 * exist.
 */
export type AgentModel = ModelId | null;

export interface ModelCapabilities {
  /** Adaptive thinking: only on the current generation. */
  adaptiveThinking: boolean;
  /** output_config.effort. Sending it to a model that does not take it is a 400. */
  effort: boolean;
  contextTokens: number;
  /** USD per million tokens, for the cost estimate written into each report. */
  priceInPerMTok: number;
  priceOutPerMTok: number;
  /**
   * The server-side web tools this model accepts, by exact `type` string. The
   * versioned names are not interchangeable: the current generation takes the
   * 2026-02-09 pair, which filters results in a sandbox before they reach the
   * context window, and older models only take the earlier pair. Sending the
   * wrong one is a 400, in the same family of mistake as sending `effort` to
   * Haiku. `null` on both means no web access for that model.
   */
  webSearchToolType: string | null;
  webFetchToolType: string | null;
}

export const MODEL_CAPABILITIES: Record<ModelId, ModelCapabilities> = {
  "claude-opus-5": {
    adaptiveThinking: true,
    effort: true,
    contextTokens: 1_000_000,
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    webSearchToolType: "web_search_20260209",
    webFetchToolType: "web_fetch_20260209",
  },
  "claude-sonnet-5": {
    adaptiveThinking: true,
    effort: true,
    contextTokens: 1_000_000,
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
    webSearchToolType: "web_search_20260209",
    webFetchToolType: "web_fetch_20260209",
  },
  "claude-haiku-4-5": {
    // Haiku 4.5 predates adaptive thinking and the effort parameter. Sending
    // either is a 400, so the request builder omits them for this model.
    adaptiveThinking: false,
    effort: false,
    contextTokens: 200_000,
    priceInPerMTok: 1,
    priceOutPerMTok: 5,
    // Haiku 4.5 predates dynamic filtering, so it takes the earlier pair.
    webSearchToolType: "web_search_20250305",
    webFetchToolType: "web_fetch_20250910",
  },
};

/**
 * What one web search costs, on top of the tokens the results consume.
 * Published as $10 per 1,000 searches. Recorded per run so a research agent's
 * bill is not just its token spend.
 */
export const WEB_SEARCH_USD_PER_CALL = 0.01;

export function capabilitiesFor(model: string): ModelCapabilities {
  const known = MODEL_CAPABILITIES[model as ModelId];
  if (known) return known;
  // An unknown model id (someone overrode a tier through an env var) is treated
  // as current-generation, which is the safe assumption for anything newer.
  return {
    adaptiveThinking: true,
    effort: true,
    contextTokens: 200_000,
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    webSearchToolType: "web_search_20260209",
    webFetchToolType: "web_fetch_20260209",
  };
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Rough USD cost of one call, recorded on the report so spend stays visible. */
export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const price = capabilitiesFor(model);
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const cachedInput = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  const cost =
    (input / 1_000_000) * price.priceInPerMTok +
    // Cache reads bill at a tenth of the input rate.
    (cachedInput / 1_000_000) * price.priceInPerMTok * 0.1 +
    (output / 1_000_000) * price.priceOutPerMTok;

  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Tier ids resolved once, so a deployment can move a whole tier without a code change. */
export function resolveTiers(env: {
  MODEL_REASONING?: string;
  MODEL_BALANCED?: string;
  MODEL_FAST?: string;
}): Record<ModelTier, string> {
  return {
    reasoning: env.MODEL_REASONING || MODELS.reasoning,
    balanced: env.MODEL_BALANCED || MODELS.balanced,
    fast: env.MODEL_FAST || MODELS.fast,
  };
}
