// Each agent's routine / needs-approval line, tested as behaviour rather than
// trusted as documentation.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/autonomy.js";
import type { AgentDefinition } from "../src/core/agent.js";
import type { ProposedAction } from "../src/core/types.js";
import { seoSiteAgent } from "../src/agents/marketing/seo-site.js";
import { contentAgent } from "../src/agents/marketing/content.js";
import { facebookAgent } from "../src/agents/marketing/facebook.js";
import { xAgent } from "../src/agents/marketing/x.js";
import { socialEngagementAgent } from "../src/agents/marketing/social-engagement.js";
import { objectionFaqAgent } from "../src/agents/sales/objection-faq.js";
import { leadPipelineAgent } from "../src/agents/sales/lead-pipeline.js";
import { financeWatchAgent } from "../src/agents/executive/finance-watch.js";
import { opsHealthAgent } from "../src/agents/executive/ops-health.js";
import { growthStrategyAgent } from "../src/agents/executive/growth-strategy.js";
import { competitiveIntelAgent } from "../src/agents/intelligence/competitive-intel.js";
import { marketingAnalyticsAgent } from "../src/agents/marketing/analytics.js";
import { FAQ_LIBRARY } from "../src/core/config.js";
import { action, ruleContext } from "./helpers.js";

function classify(agent: AgentDefinition, proposed: ProposedAction) {
  return evaluate({
    action: proposed,
    approvalRules: agent.approvalRules,
    routineRules: agent.routineRules,
    approvedChannels: agent.approvedChannels,
    ctx: ruleContext(),
  });
}

describe("Content Agent", () => {
  it("drafts inside an established pillar and format without asking", async () => {
    const decision = await classify(
      contentAgent,
      action({
        type: "draft_content",
        channel: "internal",
        payload: { pillar: "structural-architecture", format: "short-post", voiceClean: true },
      })
    );
    expect(decision.classification).toBe("routine");
  });

  it("queues a new content pillar", async () => {
    const decision = await classify(
      contentAgent,
      action({
        type: "draft_content",
        channel: "internal",
        payload: { pillar: "crypto-commentary", format: "short-post", voiceClean: true },
      })
    );
    expect(decision.ruleId).toBe("content.new_pillar");
  });

  it("queues copy that still carries AI tells", async () => {
    const decision = await classify(
      contentAgent,
      action({
        type: "draft_content",
        channel: "internal",
        payload: {
          pillar: "channel-dependency",
          format: "short-post",
          voiceClean: false,
          voiceViolations: [{ id: "em-dash" }],
        },
      })
    );
    expect(decision.ruleId).toBe("content.voice_check_failed");
  });
});

describe("Facebook Agent (channel behaviour)", () => {
  const publish = (payload: Record<string, unknown>, ref?: string) =>
    action({
      type: "publish_post",
      channel: "facebook",
      approvedContentRef: ref,
      payload,
    });

  it("publishes already-approved content on its own", async () => {
    const decision = await classify(
      facebookAgent,
      publish({ withinApprovedScope: true, text: "hello" }, "draft-1")
    );
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("facebook.publish_own_draft");
  });

  it("refuses to publish copy that never cleared the content agent", async () => {
    const decision = await classify(facebookAgent, publish({ text: "hello" }));
    expect(decision.ruleId).toBe("facebook.unapproved_copy");
  });

  it("queues paid promotion", async () => {
    const decision = await classify(
      facebookAgent,
      publish({ withinApprovedScope: true, paid: true }, "draft-1")
    );
    expect(decision.classification).toBe("needs_approval");
    expect(["facebook.paid_promotion", "general.new_by_type"]).toContain(decision.ruleId);
  });

  it("queues a new campaign type", async () => {
    const decision = await classify(
      facebookAgent,
      publish({ withinApprovedScope: true, newCampaignType: true }, "draft-1")
    );
    expect(decision.ruleId).toBe("facebook.new_campaign_type");
  });
});

describe("SEO / Site Agent", () => {
  it("edits a meta description on an ordinary page without asking", async () => {
    const decision = await classify(
      seoSiteAgent,
      action({
        type: "site_edit",
        channel: "site",
        payload: { path: "/about", kind: "meta_description", fullRestructure: false },
      })
    );
    expect(decision.classification).toBe("routine");
  });

  it("queues the same edit on a pricing page", async () => {
    const decision = await classify(
      seoSiteAgent,
      action({
        type: "site_edit",
        channel: "site",
        payload: { path: "/pricing", kind: "meta_description", fullRestructure: false },
      })
    );
    expect(decision.ruleId).toBe("seo.protected_page");
  });

  it("queues edits to legal and contract-adjacent pages", async () => {
    for (const path of ["/terms", "/privacy", "/legal/dpa", "/refund-policy"]) {
      const decision = await classify(
        seoSiteAgent,
        action({
          type: "site_edit",
          channel: "site",
          payload: { path, kind: "alt_text", fullRestructure: false },
        })
      );
      expect(decision.ruleId).toBe("seo.protected_page");
    }
  });

  it("queues a full page restructure", async () => {
    const decision = await classify(
      seoSiteAgent,
      action({
        type: "site_edit",
        channel: "site",
        payload: { path: "/about", kind: "on_page_copy", fullRestructure: true },
      })
    );
    expect(decision.ruleId).toBe("seo.full_restructure");
  });
});

describe("Social Engagement Agent", () => {
  const reply = (payload: Record<string, unknown>) =>
    action({ type: "reply_public", channel: "x", payload });

  it("answers praise on its own when the read is confident", async () => {
    const decision = await classify(
      socialEngagementAgent,
      reply({ category: "praise", confidence: 0.95, voiceClean: true })
    );
    expect(decision.classification).toBe("routine");
  });

  it("queues a reply to criticism", async () => {
    const decision = await classify(
      socialEngagementAgent,
      reply({ category: "criticism", confidence: 0.99, voiceClean: true })
    );
    expect(decision.ruleId).toBe("social_engagement.criticism_insult_or_complaint");
  });

  it("queues insults and public complaints", async () => {
    for (const category of ["insult", "public_complaint"]) {
      const decision = await classify(
        socialEngagementAgent,
        reply({ category, confidence: 0.99, voiceClean: true })
      );
      expect(decision.classification).toBe("needs_approval");
    }
  });

  it("treats an unsure read as not routine, even when it says praise", async () => {
    const decision = await classify(
      socialEngagementAgent,
      reply({ category: "praise", confidence: 0.6, voiceClean: true })
    );
    expect(decision.ruleId).toBe("social_engagement.unsure");
  });
});

describe("Objection / FAQ Agent", () => {
  const entry = FAQ_LIBRARY[0]!;

  it("answers a known question in the approved words", async () => {
    const decision = await classify(
      objectionFaqAgent,
      action({
        type: "faq_answer",
        payload: { faqId: entry.id, answer: entry.approvedAnswer, matchConfidence: 0.95 },
      })
    );
    expect(decision.classification).toBe("routine");
  });

  it("queues a rewritten version of an approved answer", async () => {
    const decision = await classify(
      objectionFaqAgent,
      action({
        type: "faq_answer",
        payload: {
          faqId: entry.id,
          answer: entry.approvedAnswer + " Let me know if that helps.",
          matchConfidence: 0.95,
        },
      })
    );
    expect(decision.ruleId).toBe("objection_faq.rewritten_answer");
  });

  it("queues a question the library does not cover", async () => {
    const decision = await classify(
      objectionFaqAgent,
      action({ type: "faq_answer", payload: { faqId: null, answer: "something new" } })
    );
    expect(decision.ruleId).toBe("objection_faq.new_or_ambiguous_question");
  });
});

describe("Lead / Pipeline Agent", () => {
  it("flags a stall without asking", async () => {
    const decision = await classify(
      leadPipelineAgent,
      action({ type: "pipeline_flag", payload: { prospectId: "p1" } })
    );
    expect(decision.classification).toBe("routine");
  });

  it("queues anything client-facing", async () => {
    const decision = await classify(
      leadPipelineAgent,
      action({ type: "client_facing_action", payload: { prospectId: "p1" } })
    );
    expect(decision.ruleId).toBe("lead_pipeline.client_facing_action");
  });
});

describe("Executive agents", () => {
  it("lets Finance-Watch report but queues a pricing recommendation", async () => {
    const monitoring = await classify(
      financeWatchAgent,
      action({ type: "observation", payload: {} })
    );
    expect(monitoring.classification).toBe("routine");

    const recommendation = await classify(
      financeWatchAgent,
      action({ type: "recommendation", payload: { changesPricing: true } })
    );
    expect(recommendation.classification).toBe("needs_approval");
  });

  it("lets Ops-Health report but queues any infrastructure change", async () => {
    const monitoring = await classify(opsHealthAgent, action({ type: "observation", payload: {} }));
    expect(monitoring.classification).toBe("routine");

    const change = await classify(
      opsHealthAgent,
      action({ type: "observation", payload: { infrastructureChange: true } })
    );
    expect(change.ruleId).toBe("ops_health.infrastructure_change");
  });

  it("queues everything Growth-Strategy proposes, by definition", async () => {
    for (const type of ["recommendation", "observation", "memory_write"] as const) {
      const decision = await classify(growthStrategyAgent, action({ type, payload: {} }));
      expect(decision.classification).toBe("needs_approval");
      expect(decision.ruleId).toBe("growth_strategy.everything_it_proposes");
    }
  });

  it("keeps Marketing Analytics on observation only", async () => {
    expect(marketingAnalyticsAgent.observeOnly).toBe(true);
    const decision = await classify(
      marketingAnalyticsAgent,
      action({ type: "observation", payload: {} })
    );
    expect(decision.classification).toBe("routine");
  });
});

describe("Competitive Intelligence Agent", () => {
  it("files a brief into its own library without asking", async () => {
    const decision = await classify(
      competitiveIntelAgent,
      action({ type: "intel_brief", channel: "internal", payload: { brief: {} } })
    );
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("competitive_intel.file_brief");
  });

  it("logs what moved on the watchlist without asking", async () => {
    const decision = await classify(
      competitiveIntelAgent,
      action({ type: "observation", channel: "internal", payload: { changed: [] } })
    );
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("competitive_intel.report_movement");
  });

  it("queues a positioning move rather than adopting it", async () => {
    const decision = await classify(
      competitiveIntelAgent,
      action({
        type: "recommendation",
        channel: "internal",
        payload: { kind: "positioning_gap", changesPositioning: true },
      })
    );
    expect(decision.classification).toBe("needs_approval");
    // Either the agent's own rule fires or the general messaging veto does.
    // Both are the right answer: what Velvex claims about itself is the
    // owner's call, and this is caught twice on purpose.
    expect([
      "competitive_intel.acts_on_nothing",
      "general.pricing_or_messaging_change",
    ]).toContain(decision.ruleId);
  });

  it("queues anything that would add to what it watches", async () => {
    const decision = await classify(
      competitiveIntelAgent,
      action({ type: "memory_write", channel: "internal", payload: { watchlistAddition: true } })
    );
    expect(decision.classification).toBe("needs_approval");
  });

  it("cannot act externally even if it tried", async () => {
    expect(competitiveIntelAgent.observeOnly).toBe(true);
    expect(competitiveIntelAgent.approvedChannels).toEqual(["internal"]);
    for (const channel of ["x", "linkedin", "site"] as const) {
      const decision = await classify(
        competitiveIntelAgent,
        action({ type: "publish_post", channel, payload: {} })
      );
      expect(decision.classification).toBe("needs_approval");
    }
  });

  it("does nothing at all until it has somewhere to file a brief", async () => {
    // The library is a fourth table added by migration 0002. Without it the
    // agent must stop BEFORE the two Opus passes, not after: a run that
    // researches and then cannot file has spent real money for nothing.
    const logs: string[] = [];
    const result = await competitiveIntelAgent.propose({
      env: { INTEL_WEB_RESEARCH_ENABLED: "true" } as unknown as import("../src/env.js").Env,
      db: {
        intelReady: async () => ({ ok: false, error: "relation does not exist" }),
      } as unknown as import("../src/lib/supabase.js").Supabase,
      claude: new Proxy(
        {},
        {
          get() {
            throw new Error("the agent must not reach the model before the table exists");
          },
        }
      ) as unknown as import("../src/lib/claude.js").Claude,
      judge: {} as unknown as import("../src/core/types.js").Judge,
      runId: "r",
      now: new Date("2026-08-24T08:00:00Z"),
      trigger: "cron",
      log: (message) => logs.push(message),
    });

    expect(result).toEqual([]);
    expect(logs.join(" ")).toContain("0002_intelligence_layer.sql");
  });

  it("says it has nothing to look at rather than researching an empty desk", async () => {
    const result = await competitiveIntelAgent.propose({
      env: { INTEL_WEB_RESEARCH_ENABLED: "false" } as unknown as import("../src/env.js").Env,
      db: {
        intelReady: async () => ({ ok: true }),
        readMemory: async () => [],
      } as unknown as import("../src/lib/supabase.js").Supabase,
      claude: new Proxy(
        {},
        {
          get() {
            throw new Error("no watchlist and no web access means no model call");
          },
        }
      ) as unknown as import("../src/lib/claude.js").Claude,
      judge: {} as unknown as import("../src/core/types.js").Judge,
      runId: "r",
      now: new Date("2026-08-24T08:00:00Z"),
      trigger: "cron",
      log: () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("observation");
    expect(result[0]!.payload["active"]).toBe(false);
  });
});

describe("Channel strategist drafts and growth ideas", () => {
  it("makes drafting for the strategist's own channel routine", async () => {
    const decision = await classify(
      xAgent,
      action({
        type: "draft_content",
        channel: "internal",
        payload: {
          pillar: "structural-architecture",
          format: "short-post",
          channelHint: "x",
          voiceClean: true,
        },
      })
    );
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("x.draft_inside_pillars");
  });

  it("does not treat one strategist's draft as another strategist's routine work", async () => {
    const decision = await classify(
      xAgent,
      action({
        type: "draft_content",
        channel: "internal",
        payload: {
          pillar: "structural-architecture",
          format: "short-post",
          channelHint: "linkedin", // wrong channel
          voiceClean: true,
        },
      })
    );
    expect(decision.classification).toBe("needs_approval");
  });

  it("queues every growth idea, by rule and by classification", async () => {
    const decision = await classify(
      xAgent,
      action({
        type: "campaign_direction",
        channel: "x",
        payload: { title: "Engage the coffee wholesale sub", growthExperiment: true, risk: "medium" },
      })
    );
    expect(decision.classification).toBe("needs_approval");
    // Either the strategist's growth rule fires, or the general new-by-type
    // veto does; both correctly queue it. Order does not change the outcome.
    expect(["x.growth_experiment", "general.new_by_type"]).toContain(decision.ruleId);
  });

  it("queues engaging a specific external account by name", async () => {
    const decision = await classify(
      xAgent,
      action({
        type: "reply_public",
        channel: "x",
        payload: { engagesExternalAccount: true, account: "@someone" },
      })
    );
    expect(decision.ruleId).toBe("x.engage_external_account");
  });
});

describe("Facebook strategist is dormant when the flag is off", () => {
  it("returns nothing on a cron tick until FACEBOOK_ENABLED is true", async () => {
    const result = await facebookAgent.propose({
      env: { FACEBOOK_ENABLED: "false" } as unknown as import("../src/env.js").Env,
      db: {} as unknown as import("../src/lib/supabase.js").Supabase,
      claude: {} as unknown as import("../src/lib/claude.js").Claude,
      judge: {} as unknown as import("../src/core/types.js").Judge,
      runId: "r",
      now: new Date(),
      trigger: "cron",
      log: () => {},
    });
    expect(result).toEqual([]);
  });
});
