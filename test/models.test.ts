// Model selection, and the capability differences that make it a 400 rather
// than a degradation when you get it wrong.

import { describe, expect, it } from "vitest";
import {
  buildRequest,
  countSearches,
  extractWebSources,
  webTools,
  type Claude,
} from "../src/lib/claude.js";
import { spamTriage } from "../src/lib/judge.js";
import {
  MODELS,
  capabilitiesFor,
  estimateCostUsd,
  resolveTiers,
} from "../src/core/models.js";
import { AGENTS } from "../src/agents/registry.js";

const base = { system: "s", user: "u", effort: "high" as const };

describe("request building per model", () => {
  it("sends adaptive thinking and effort to the current generation", () => {
    for (const model of [MODELS.reasoning, MODELS.balanced]) {
      const request = buildRequest({ ...base, model });
      expect(request.thinking).toEqual({ type: "adaptive" });
      expect(request.output_config?.effort).toBe("high");
    }
  });

  it("sends neither to Haiku 4.5, which rejects both", () => {
    const request = buildRequest({ ...base, model: MODELS.fast });
    expect(request.thinking).toBeUndefined();
    expect(request.output_config?.effort).toBeUndefined();
  });

  it("still constrains Haiku output to a schema", () => {
    const schema = { type: "object", properties: {} };
    const request = buildRequest({ ...base, model: MODELS.fast, schema });
    expect(request.output_config?.format).toEqual({ type: "json_schema", schema });
    expect(request.output_config?.effort).toBeUndefined();
  });

  it("treats an unknown model id as current generation", () => {
    const request = buildRequest({ ...base, model: "claude-something-newer" });
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(capabilitiesFor("claude-something-newer").effort).toBe(true);
  });

  it("defaults max_tokens but honours an override", () => {
    expect(buildRequest({ ...base, model: MODELS.balanced }).max_tokens).toBe(16000);
    expect(buildRequest({ ...base, model: MODELS.balanced, maxTokens: 600 }).max_tokens).toBe(600);
  });
});

// Server-side web access. Only the intelligence agent asks for it, and the
// tool `type` string is versioned per model generation: sending the current
// pair to a model that only takes the earlier one is a 400 before the model
// runs, the same failure mode as sending `effort` to Haiku.
describe("web tools per model", () => {
  const web = { maxSearches: 8, maxFetches: 5 };

  it("gives the current generation the dynamic-filtering pair", () => {
    for (const model of [MODELS.reasoning, MODELS.balanced]) {
      const tools = webTools(model, web);
      expect(tools.map((tool) => tool["type"])).toEqual([
        "web_search_20260209",
        "web_fetch_20260209",
      ]);
      expect(tools[0]!["max_uses"]).toBe(8);
      expect(tools[1]!["max_uses"]).toBe(5);
    }
  });

  it("gives Haiku 4.5 the earlier pair, which is what it accepts", () => {
    expect(webTools(MODELS.fast, web).map((tool) => tool["type"])).toEqual([
      "web_search_20250305",
      "web_fetch_20250910",
    ]);
  });

  it("never sends both domain lists, which the API rejects", () => {
    const tools = webTools(MODELS.reasoning, {
      ...web,
      allowedDomains: ["example.com"],
      blockedDomains: ["spam.test"],
    });
    for (const tool of tools) {
      expect(tool["allowed_domains"]).toEqual(["example.com"]);
      expect(tool).not.toHaveProperty("blocked_domains");
    }
  });

  it("declares nothing when a cap is zero", () => {
    expect(webTools(MODELS.reasoning, { maxSearches: 0, maxFetches: 0 })).toEqual([]);
  });

  it("only puts tools on a request that asked for them", () => {
    expect(buildRequest({ ...base, model: MODELS.reasoning }).tools).toBeUndefined();
    expect(buildRequest({ ...base, model: MODELS.reasoning, web }).tools).toHaveLength(2);
  });

  it("still sends thinking and effort alongside the tools", () => {
    const request = buildRequest({ ...base, model: MODELS.reasoning, web });
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config?.effort).toBe("high");
  });
});

describe("reading what a web-enabled turn actually looked at", () => {
  it("pulls the pages out of the result blocks, without duplicates", () => {
    const sources = extractWebSources([
      { type: "text", text: "hi" },
      {
        type: "web_search_tool_result",
        content: [
          { url: "https://a.test/", title: "A" },
          { url: "https://b.test/", title: "B" },
          { url: "https://a.test/", title: "A again" },
        ],
      },
      {
        type: "web_fetch_tool_result",
        content: { url: "https://c.test/", document: { title: "C" } },
      },
    ]);
    expect(sources.map((source) => source.url)).toEqual([
      "https://a.test/",
      "https://b.test/",
      "https://c.test/",
    ]);
    expect(sources[2]!.via).toBe("fetch");
  });

  it("survives a failed search, which returns an object where success returns a list", () => {
    // A web search error is HTTP 200 with an error object in `content`.
    // Indexing it as a list would throw or silently yield nothing.
    expect(() =>
      extractWebSources([
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
      ])
    ).not.toThrow();
    expect(
      extractWebSources([
        { type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } },
      ])
    ).toEqual([]);
  });

  it("counts the searches, which are billed per call on top of tokens", () => {
    expect(
      countSearches([
        { type: "server_tool_use", name: "web_search" },
        { type: "server_tool_use", name: "web_fetch" },
        { type: "server_tool_use", name: "web_search" },
        { type: "text", text: "x" },
      ])
    ).toBe(2);
  });
});

describe("cost estimation", () => {
  it("prices each tier at its own rate", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(estimateCostUsd(MODELS.reasoning, usage)).toBeCloseTo(30, 5); // 5 + 25
    expect(estimateCostUsd(MODELS.balanced, usage)).toBeCloseTo(18, 5); // 3 + 15
    expect(estimateCostUsd(MODELS.fast, usage)).toBeCloseTo(6, 5); // 1 + 5
  });

  it("bills cache reads at a tenth of the input rate", () => {
    const cost = estimateCostUsd(MODELS.balanced, {
      input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.3, 5);
  });

  it("is zero when there is no usage to price", () => {
    expect(estimateCostUsd(MODELS.reasoning, undefined)).toBe(0);
  });
});

describe("tier resolution", () => {
  it("uses the built-in defaults", () => {
    expect(resolveTiers({})).toEqual({
      reasoning: "claude-opus-5",
      balanced: "claude-sonnet-5",
      fast: "claude-haiku-4-5",
    });
  });

  it("lets a deployment move a whole tier without a code change", () => {
    expect(resolveTiers({ MODEL_BALANCED: "claude-opus-5" }).balanced).toBe("claude-opus-5");
  });
});

describe("the roster's model assignments", () => {
  const modelOf = (id: string) => AGENTS.find((agent) => agent.id === id)?.model;

  it("puts public writing and cross-department judgement on the reasoning tier", () => {
    expect(modelOf("content")).toBe(MODELS.reasoning);
    expect(modelOf("social_engagement")).toBe(MODELS.reasoning);
    expect(modelOf("growth_strategy")).toBe(MODELS.reasoning);
    expect(modelOf("chief_of_staff")).toBe(MODELS.reasoning);
  });

  it("puts bounded reading and writing on the balanced tier", () => {
    expect(modelOf("seo_site")).toBe(MODELS.balanced);
    expect(modelOf("marketing_analytics")).toBe(MODELS.balanced);
    expect(modelOf("objection_faq")).toBe(MODELS.balanced);
    expect(modelOf("finance_watch")).toBe(MODELS.balanced);
  });

  it("puts each channel strategist on the reasoning tier", () => {
    for (const id of ["facebook", "x", "linkedin"]) {
      expect(modelOf(id)).toBe(MODELS.reasoning);
    }
  });

  it("still gives no model to the agents whose work is pure arithmetic", () => {
    for (const id of ["lead_pipeline", "ops_health"]) {
      expect(modelOf(id)).toBeNull();
    }
  });

  it("never assigns a model id that is not one of the three tiers", () => {
    const tiers: Array<string | null> = [MODELS.reasoning, MODELS.balanced, MODELS.fast, null];
    for (const agent of AGENTS) {
      expect(tiers).toContain(agent.model);
    }
  });
});

describe("the fast-tier spam filter", () => {
  const claudeReturning = (parsed: unknown) =>
    ({
      modelFor: () => MODELS.fast,
      complete: async () => ({ parsed }),
    }) as unknown as Claude;

  it("drops spam only when it is confident", async () => {
    expect(await spamTriage(claudeReturning({ spam: true, confidence: 0.97 }), "buy followers cheap"))
      .toEqual({ isSpam: true, confidence: 0.97 });
    expect((await spamTriage(claudeReturning({ spam: true, confidence: 0.5 }), "hmm, is this a real service?")).isSpam).toBe(false);
  });

  it("passes a message through when the filter fails", async () => {
    const broken = {
      modelFor: () => MODELS.fast,
      complete: async () => {
        throw new Error("model unreachable");
      },
    } as unknown as Claude;
    expect(await spamTriage(broken, "your pricing is a joke")).toEqual({ isSpam: false, confidence: 0 });
  });
});
