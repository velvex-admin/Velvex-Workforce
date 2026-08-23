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
  WEB_SEARCH_USD_PER_CALL,
  type ModelTier,
  type TokenUsage,
} from "../core/models.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Server-side web access, for the one agent whose job is outside this system.
 *
 * These tools run on Anthropic's infrastructure: we declare them and read the
 * results out of the response, we never execute anything. Two things about
 * them shape the code below.
 *
 * The tool `type` is versioned per model generation and the wrong one is a
 * 400, so it comes from MODEL_CAPABILITIES rather than being written inline.
 *
 * And a server-tool turn can stop with `stop_reason: "pause_turn"` when its
 * internal loop hits its limit. That is not an error and nothing warns about
 * it: the reply just arrives half-finished. `complete()` resumes it.
 */
export interface WebAccess {
  /** Hard cap on searches this call may run. Each one is billed. */
  maxSearches: number;
  /** Hard cap on page fetches. Fetch only reads URLs already in the conversation. */
  maxFetches: number;
  /** When set, searching is confined to these hosts. */
  allowedDomains?: string[];
  /** When set, these hosts are excluded. Never send both lists. */
  blockedDomains?: string[];
}

/** A page the model actually looked at, pulled out of the result blocks. */
export interface WebSource {
  url: string;
  title?: string;
  via: "search" | "fetch";
}

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
  /**
   * Give this call the server-side web tools. Left unset everywhere except the
   * intelligence agent's research pass: every other agent in this system
   * reasons over data we already hold.
   */
  web?: WebAccess;
}

export interface CompleteResult<T = string> {
  text: string;
  parsed?: T;
  model: string;
  effort: Effort | null;
  usage: TokenUsage;
  /** Rough USD for this call. Written onto the report so spend stays visible. */
  costUsd: number;
  /** Pages the model consulted, when web access was granted. */
  sources: WebSource[];
  /** How many searches ran. Billed per search, so it is reported separately. */
  searchesUsed: number;
  /**
   * True when the turn was still paused after the continuation cap, meaning the
   * answer is what the model had reached rather than what it had finished. The
   * caller decides what that is worth; it is never silently presented as whole.
   */
  truncated: boolean;
}

/**
 * How many times a paused turn is resumed before we stop. Each resume is a
 * fresh billed request, so this is a spend ceiling as much as a loop guard.
 */
const MAX_CONTINUATIONS = 4;

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
  /** Server-side tools only. We never declare a tool we would have to run. */
  tools?: Array<Record<string, unknown>>;
}

interface CurrentMessage extends Anthropic.Message {
  stop_details?: { type: string; category?: string | null; explanation?: string } | null;
}

/**
 * The response blocks the server tools produce. The SDK version pinned here
 * does not type them, and they are read structurally rather than cast blindly:
 * a web search that fails returns HTTP 200 with an error OBJECT where a success
 * returns an ARRAY, so anything reading `.content` has to check which it got.
 */
interface ServerToolResultBlock {
  type: string;
  content?: unknown;
}

/** Pull the pages a response actually consulted out of its content blocks. */
export function extractWebSources(content: unknown[]): WebSource[] {
  const seen = new Set<string>();
  const sources: WebSource[] = [];

  const push = (url: unknown, title: unknown, via: WebSource["via"]) => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, ...(typeof title === "string" && title ? { title } : {}), via });
  };

  for (const raw of content) {
    const block = raw as ServerToolResultBlock;
    if (!block || typeof block !== "object") continue;

    if (block.type === "web_search_tool_result") {
      // An error result is a single object, not a list. Indexing it would
      // silently yield nothing; branching on it keeps the failure visible.
      if (!Array.isArray(block.content)) continue;
      for (const result of block.content) {
        const item = result as Record<string, unknown>;
        push(item["url"], item["title"], "search");
      }
      continue;
    }

    if (block.type === "web_fetch_tool_result") {
      const result = block.content as Record<string, unknown> | undefined;
      if (!result || Array.isArray(result)) continue;
      const document = result["document"] as Record<string, unknown> | undefined;
      push(result["url"], document?.["title"], "fetch");
    }
  }

  return sources;
}

/** How many searches a response ran, for the per-search line on the bill. */
export function countSearches(content: unknown[]): number {
  return content.filter((raw) => {
    const block = raw as Record<string, unknown>;
    return (
      block &&
      typeof block === "object" &&
      block["type"] === "server_tool_use" &&
      block["name"] === "web_search"
    );
  }).length;
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
  web?: WebAccess;
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

  if (args.web) {
    const tools = webTools(args.model, args.web);
    if (tools.length > 0) request.tools = tools;
  }

  return request;
}

/**
 * The server-tool declarations for one call, at the versions this model takes.
 *
 * Returns an empty list when the model has no web tools, so asking for web
 * access on a model that cannot do it degrades to a normal call rather than
 * 400ing. Only one of allowed/blocked domains is ever sent: the API rejects
 * both together, and allowed wins because it is the tighter of the two.
 */
export function webTools(model: string, web: WebAccess): Array<Record<string, unknown>> {
  const capabilities = capabilitiesFor(model);
  const tools: Array<Record<string, unknown>> = [];

  const domains: Record<string, unknown> = web.allowedDomains?.length
    ? { allowed_domains: web.allowedDomains }
    : web.blockedDomains?.length
      ? { blocked_domains: web.blockedDomains }
      : {};

  if (capabilities.webSearchToolType && web.maxSearches > 0) {
    tools.push({
      type: capabilities.webSearchToolType,
      name: "web_search",
      max_uses: web.maxSearches,
      ...domains,
    });
  }

  if (capabilities.webFetchToolType && web.maxFetches > 0) {
    tools.push({
      type: capabilities.webFetchToolType,
      name: "web_fetch",
      max_uses: web.maxFetches,
      ...domains,
    });
  }

  return tools;
}

/** Add up two usage records, so a resumed turn reports what the whole turn cost. */
function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
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
      ...(args.web ? { web: args.web } : {}),
      ...(effort ? { effort } : {}),
    });

    try {
      // One turn, plus however many resumes a paused server-tool loop needs.
      //
      // A turn using server tools runs its own sampling loop on Anthropic's
      // side. When that loop hits its limit the response comes back with
      // stop_reason "pause_turn": HTTP 200, no error, no warning, and an answer
      // that simply stops partway. Resuming means re-sending the same request
      // with the paused assistant turn appended; the API sees the trailing
      // server_tool_use block and picks up where it left off. No extra user
      // message, and certainly not the word "Continue", which would become part
      // of the conversation.
      let messages = request.messages;
      let text = "";
      let usage: TokenUsage = {};
      let sources: WebSource[] = [];
      let searchesUsed = 0;
      let truncated = false;
      let response!: CurrentMessage;

      for (let attempt = 0; ; attempt += 1) {
        response = (await this.client.messages.create({
          ...request,
          messages,
        } as unknown as Anthropic.MessageCreateParamsNonStreaming)) as CurrentMessage;

        if (response.stop_reason === "refusal") {
          throw new ModelError(
            `Model declined the request (${response.stop_details?.category ?? "unspecified"})`
          );
        }

        for (const block of response.content) {
          if (block.type === "text") text += block.text;
        }
        usage = addUsage(usage, response.usage as unknown as TokenUsage);
        searchesUsed += countSearches(response.content);
        for (const source of extractWebSources(response.content)) {
          if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
        }

        if (response.stop_reason !== "pause_turn") break;

        if (attempt >= MAX_CONTINUATIONS) {
          // Still paused after the cap. The caller is told, rather than handed
          // a partial answer that looks complete.
          truncated = true;
          break;
        }

        messages = [...messages, { role: "assistant", content: response.content }];
      }

      let parsed: T | undefined;
      if (args.schema) {
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          throw new ModelError(`Expected JSON matching the schema, got: ${text.slice(0, 200)}`);
        }
      }

      // Searches are billed per call on top of tokens, so they are added here
      // rather than left off the estimate the dashboard shows.
      const costUsd =
        Math.round(
          (estimateCostUsd(model, usage) + searchesUsed * WEB_SEARCH_USD_PER_CALL) * 1_000_000
        ) / 1_000_000;
      this.spentUsd = Math.round((this.spentUsd + costUsd) * 1_000_000) / 1_000_000;
      this.callCount += 1;

      return {
        text,
        parsed,
        model,
        effort,
        usage,
        costUsd,
        sources,
        searchesUsed,
        truncated,
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
