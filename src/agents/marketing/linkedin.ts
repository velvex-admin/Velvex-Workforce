// LinkedIn Agent — Marketing. EXTERNAL BUILD.
//
// Doc: already being built by an outside company; integrates into this system
// as a connector once ready. Publishes content-agent drafts on a schedule it
// determines.
//
// So there is deliberately no agent logic here. This entry exists so the
// LinkedIn agent appears in the roster with its rules recorded, and so the rest
// of the system has something to name when it hands work over. The runner skips
// any agent marked externalBuild; drafts destined for LinkedIn go into the
// partner queue in src/connectors/linkedin.ts, which the outside agent collects.

import type { AgentDefinition } from "../../core/agent.js";

export const linkedInAgent: AgentDefinition = {
  id: "linkedin",
  name: "LinkedIn Agent",
  batch: "marketing",
  description:
    "External build. Publishes content-agent drafts on a schedule it determines; this project exposes the queue it collects from and the endpoints it reports back to.",
  // Somebody else's build, and somebody else's model cost.
  model: null,
  effort: "medium",
  cadence: "external",
  externalBuild: true,
  approvedChannels: ["linkedin"],

  // Recorded from the doc so the boundary is documented in the roster even
  // though the outside agent enforces its own side of it.
  routineRules: [
    {
      id: "linkedin.publish_approved_content",
      describe: "Timing and publishing of already-approved content.",
      classification: "routine",
      test: () => null,
    },
  ],
  approvalRules: [
    {
      id: "linkedin.new_campaign_or_paid",
      describe: "New campaign type or any paid promotion.",
      classification: "needs_approval",
      risk: "high",
      test: () => null,
    },
  ],

  async propose() {
    return [];
  },

  async execute() {
    return {
      outcome: "no_op" as const,
      detail: {
        note: "LinkedIn is an external build. Work reaches it through the partner queue, not through this runner.",
      },
    };
  },
};
