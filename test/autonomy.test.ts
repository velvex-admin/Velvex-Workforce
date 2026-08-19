import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/autonomy.js";
import { action, failingJudge, ruleContext } from "./helpers.js";

const base = {
  approvalRules: [],
  routineRules: [
    {
      id: "test.routine_observation",
      describe: "observations are routine",
      classification: "routine" as const,
      test: (a: { type: string }) => (a.type === "observation" ? "observation" : null),
    },
  ],
  approvedChannels: ["facebook"] as const,
};

describe("the general autonomy boundary", () => {
  it("lets a matched routine action through", async () => {
    const decision = await evaluate({ ...base, action: action(), ctx: ruleContext() });
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("test.routine_observation");
  });

  it("queues anything no routine rule covers", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ type: "publish_post" }),
      ctx: ruleContext(),
    });
    expect(decision.classification).toBe("needs_approval");
    expect(decision.ruleId).toBe("general.default_deny");
  });

  it("queues spending money even when the action is otherwise routine", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ spendMinorUnits: 500 }),
      ctx: ruleContext(),
    });
    expect(decision.classification).toBe("needs_approval");
    expect(decision.ruleId).toBe("general.spend");
    expect(decision.risk).toBe("high");
  });

  it("queues anything marked irreversible", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ reversible: false }),
      ctx: ruleContext(),
    });
    expect(decision.ruleId).toBe("general.irreversible");
  });

  it("treats a channel outside the approved set as a new channel", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ channel: "x" }),
      ctx: ruleContext(),
    });
    expect(decision.ruleId).toBe("general.new_channel");
  });

  it("queues pricing and positioning changes", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ payload: { changesPricing: true } }),
      ctx: ruleContext(),
    });
    expect(decision.ruleId).toBe("general.pricing_or_messaging_change");
  });

  it("queues contact outside the normal flow", async () => {
    const decision = await evaluate({
      ...base,
      action: action({ payload: { contactOutsideNormalFlow: true } }),
      ctx: ruleContext(),
    });
    expect(decision.ruleId).toBe("general.outside_normal_flow");
  });

  it("queues action types that are new by definition", async () => {
    for (const type of ["new_content_pillar", "campaign_direction", "campaign_type", "paid_promotion"] as const) {
      const decision = await evaluate({ ...base, action: action({ type }), ctx: ruleContext() });
      expect(decision.classification).toBe("needs_approval");
    }
  });

  it("queues rather than acts when a rule cannot be evaluated", async () => {
    const decision = await evaluate({
      ...base,
      approvalRules: [
        {
          id: "test.needs_judge",
          describe: "asks the judge",
          classification: "needs_approval",
          test: async (_a, ctx) => {
            await ctx.judge.categorize({ text: "x", categories: ["a"], instruction: "" });
            return null;
          },
        },
      ],
      action: action(),
      ctx: ruleContext(failingJudge),
    });
    expect(decision.classification).toBe("needs_approval");
    expect(decision.ruleId).toBe("general.judgement_unavailable");
  });

  it("lets an approval rule veto an action a routine rule would have allowed", async () => {
    const decision = await evaluate({
      ...base,
      approvalRules: [
        {
          id: "test.veto",
          describe: "always vetoes",
          classification: "needs_approval",
          test: () => "vetoed",
        },
      ],
      action: action(),
      ctx: ruleContext(),
    });
    expect(decision.ruleId).toBe("test.veto");
  });
});
