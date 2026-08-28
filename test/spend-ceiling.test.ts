// What one run may cost, and what happens when it costs more.
//
// Written after a real incident. A research pass with server tools paused four
// times; every resume re-sent the whole accumulated conversation, including
// every search result and fetched page, at full input price. One run cost over
// three dollars and then failed on something unrelated. Nothing stopped it,
// because nothing was counting between requests.
//
// Two properties matter and neither is visible in a typecheck: cost is banked
// as each turn finishes rather than at the end, and the ceiling is checked
// before every request including every continuation. A ceiling checked once at
// the start would not have stopped that run at any point.

import { describe, expect, it } from "vitest";
import { BudgetExceededError, Claude, buildRequest, webTools } from "../src/lib/claude.js";
import type { Env } from "../src/env.js";
import { MODELS, estimateCostUsd } from "../src/core/models.js";
import { AGENTS } from "../src/agents/registry.js";

describe("the request that resumes a paused turn", () => {
  const web = { maxSearches: 8, maxFetches: 5 };

  it("asks for the prefix to be cached", () => {
    // The whole conversation is re-sent on every resume. Cache reads bill at a
    // tenth of the input rate, which is the difference between this pass
    // costing cents and costing dollars.
    const request = buildRequest({ system: "s", user: "u", model: MODELS.reasoning, web });
    expect(request.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not ask for caching on a call that cannot grow", () => {
    // A short single-shot request never reaches the minimum cacheable prefix,
    // so asking for it buys nothing.
    const request = buildRequest({ system: "s", user: "u", model: MODELS.reasoning });
    expect(request.cache_control).toBeUndefined();
  });

  it("caps what a single fetched page may contribute", () => {
    // Without this, one long page dominates the conversation and every
    // subsequent resume re-sends it.
    const fetchTool = webTools(MODELS.reasoning, web).find((tool) => tool["name"] === "web_fetch");
    expect(fetchTool?.["max_content_tokens"]).toBe(12_000);
  });

  it("lets a caller tighten that cap", () => {
    const tools = webTools(MODELS.reasoning, { ...web, maxContentTokens: 4000 });
    expect(tools.find((tool) => tool["name"] === "web_fetch")?.["max_content_tokens"]).toBe(4000);
  });
});

describe("the arithmetic that made a run cost three dollars", () => {
  it("shows what an uncached resume loop actually bills", () => {
    // Four resumes over a conversation that has accumulated 60k tokens of
    // search results. Each request re-sends everything before it.
    const accumulated = 60_000;
    const turns = [5_000, accumulated, accumulated * 2, accumulated * 3, accumulated * 4];
    const uncached = turns.reduce(
      (total, input) => total + estimateCostUsd(MODELS.reasoning, { input_tokens: input }),
      0
    );
    expect(uncached).toBeGreaterThan(2.5);

    // The same shape with the prefix served from cache, which bills at a tenth.
    const cached = turns.reduce(
      (total, input, index) =>
        total +
        estimateCostUsd(
          MODELS.reasoning,
          index === 0 ? { input_tokens: input } : { cache_read_input_tokens: input }
        ),
      0
    );
    expect(cached).toBeLessThan(0.4);
  });
});

describe("the ceiling", () => {
  it("is set on the agent that can actually run away", () => {
    // Three Opus passes with web access, one of which can be resumed several
    // times. It is the only agent in the system with that shape.
    const intel = AGENTS.find((agent) => agent.id === "competitive_intel");
    expect(intel?.spendCapUsd).toBeGreaterThan(0);
    expect(intel?.spendCapUsd).toBeLessThan(3);
  });

  it("carries what was spent and what the limit was", () => {
    // The message is read by the owner in the approvals queue, so it has to say
    // more than "budget exceeded".
    const error = new BudgetExceededError(3.4012, 1.25);
    expect(error.message).toContain("$3.4012");
    expect(error.message).toContain("$1.25");
    expect(error.spentUsd).toBe(3.4012);
    expect(error.capUsd).toBe(1.25);
  });
});

describe("how a request is sent", () => {
  it("streams, because a long non-streaming call dies at the edge", async () => {
    // The failure this prevents: a research pass at effort high with server
    // tools and a 32000 token budget takes longer to answer than the ~100
    // second edge timeout in front of the API. Non-streaming, that connection
    // carries nothing until the end, so it is cut with a 524 and the run fails
    // having already been billed. Streaming keeps bytes moving.
    const claude = new Claude({
      ANTHROPIC_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
    } as unknown as Env);

    let streamed = false;
    (claude as unknown as { client: unknown }).client = {
      messages: {
        create: async () => {
          throw new Error("this call must not be made");
        },
        stream: () => {
          streamed = true;
          return {
            finalMessage: async () => ({
              stop_reason: "end_turn",
              content: [{ type: "text", text: "ok" }],
              usage: { input_tokens: 10, output_tokens: 10 },
            }),
          };
        },
      },
    };

    const result = await claude.complete({ system: "s", user: "u", model: MODELS.reasoning });
    expect(streamed).toBe(true);
    expect(result.text).toBe("ok");
  });
});

describe("the ceiling stopping a runaway loop", () => {
  /** A Claude whose transport is replaced, so nothing leaves the process. */
  function stubbed(turnCostTokens: number, pauses: number) {
    const claude = new Claude({
      ANTHROPIC_API_KEY: "test-key",
      SUPABASE_URL: "https://example.supabase.co",
    } as unknown as Env);

    let calls = 0;
    (claude as unknown as { client: unknown }).client = {
      messages: {
        // Every model call must go out streamed. A non-streaming request holds
        // an idle connection open until the whole answer is ready and gets cut
        // at the edge with a 524, after the model has done the work and billed
        // for it. Stubbing create() as a throw is what keeps that from being
        // reintroduced quietly: the type is identical either way, so a
        // typecheck would not notice.
        create: async () => {
          throw new Error("model calls must be streamed, not created");
        },
        stream: () => ({
          finalMessage: async () => {
            calls += 1;
            return {
              // Keep pausing, which is exactly the shape that ran up the bill.
              stop_reason: calls <= pauses ? "pause_turn" : "end_turn",
              content: [{ type: "text", text: "chunk " }],
              usage: { input_tokens: turnCostTokens, output_tokens: 100 },
            };
          },
        }),
      },
    };

    return { claude, calls: () => calls };
  }

  it("stops the loop once the cap is reached, mid-run", () => {
    // The money is spent between requests, so this is the only place a check
    // can actually save anything.
    const { claude, calls } = stubbed(200_000, 10);
    claude.capSpend(1.25);

    return claude
      .complete({ system: "s", user: "u", model: MODELS.reasoning })
      .then(
        () => {
          throw new Error("the call should have been stopped by the ceiling");
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(BudgetExceededError);
          // It stopped part way rather than running all ten pauses.
          expect(calls()).toBeGreaterThan(0);
          expect(calls()).toBeLessThan(10);
          expect(claude.spentUsd).toBeGreaterThan(0);
        }
      );
  });

  it("does not interfere with a run that stays inside its cap", async () => {
    const { claude } = stubbed(1_000, 2);
    claude.capSpend(1.25);
    const result = await claude.complete({ system: "s", user: "u", model: MODELS.reasoning });
    // Three turns: two pauses, then the end.
    expect(result.text).toBe("chunk chunk chunk ");
    expect(claude.spentUsd).toBeLessThan(1.25);
  });

  it("lifts the cap when cleared, so one agent cannot starve the next", () => {
    const { claude } = stubbed(200_000, 0);
    claude.capSpend(0.0001);
    claude.clearSpendCap();
    return expect(
      claude.complete({ system: "s", user: "u", model: MODELS.reasoning })
    ).resolves.toBeTruthy();
  });
});
