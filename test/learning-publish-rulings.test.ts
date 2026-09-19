// On a channel where every post waits for the owner, the post ruling IS the
// signal — and the layer was ignoring it.
//
// Growth ideas always queue, so they always carry a verdict, and that is all the
// learning layer collected. On X that is the right and only choice: a publish
// there classifies routine and goes out without anyone deciding anything, so an
// episode for it would sit unresolved for ever and drag the ring down with it.
//
// `approveBeforePublish` inverts exactly that condition. Every LinkedIn post is
// approved or rejected by the owner, which is a verdict on the COPY rather than
// on an idea about copy — denser, more direct, and more use to the next draft
// than any growth-idea ruling. Learning from LinkedIn while ignoring it would
// have meant learning about the page from the handful of growth ideas alone.
//
// The distinction has to be the approval gate, not the channel name, or turning
// the gate on for a third channel later would silently fail to collect anything.

import { describe, expect, it } from "vitest";
import { absorbVerdicts, buildFeatures } from "../src/core/learning-store.js";
import { emptyRecord } from "../src/core/learning.js";
import { linkedInAgent } from "../src/agents/marketing/linkedin.js";
import { xAgent } from "../src/agents/marketing/x.js";
import linkedInSource from "../src/agents/marketing/linkedin.ts?raw";
import channelAgentSource from "../src/agents/marketing/channel-agent.ts?raw";
import type { ApprovalRow, Supabase } from "../src/lib/supabase.js";

const NOW = new Date("2026-09-03T12:00:00Z");

/** What the LinkedIn agent's spec resolves to, mirrored from learnsFrom(). */
const GATED = {
  kinds: { campaign_direction: "growth_idea", publish_post: "draft", schedule_post: "draft" } as const,
  channel: "linkedin",
};
/** What an ungated channel like X resolves to. */
const UNGATED = {
  kinds: { campaign_direction: "growth_idea" } as const,
  channel: "x",
};

function row(over: Partial<ApprovalRow>): ApprovalRow {
  return {
    agent_id: "linkedin",
    agent_batch: "marketing",
    title: "Publish to linkedin",
    rationale: "r",
    trigger_rule: "linkedin.publish_needs_sign_off",
    status: "executed",
    decided_at: "2026-09-02T15:00:00Z",
    ...over,
  } as ApprovalRow;
}

const publishRow = (id: string, status: ApprovalRow["status"], pillar = "channel-dependency") =>
  row({
    status,
    dedupe_key: `linkedin:publish:linkedin:${id}`,
    action: {
      type: "publish_post",
      summary: "Publish to linkedin",
      channel: "linkedin",
      payload: { draftId: id, text: "a structural observation", pillar, format: "short-post" },
    },
  });

const growthRow = (title: string) =>
  row({
    title: `linkedin growth idea: ${title}`,
    trigger_rule: "general.new_by_type",
    dedupe_key: `linkedin:growth:linkedin:${title}`,
    action: {
      type: "campaign_direction",
      summary: title,
      channel: "linkedin",
      payload: { title, risk: "low" },
    },
  });

/** A connector failure. The Chief-of-Staff files these as observations. */
const problemRow = () =>
  row({
    title: "linkedin hit a problem",
    trigger_rule: "chief_of_staff.problem_escalation",
    dedupe_key: "problem:linkedin:Publish to linkedin failed:2026-09-02",
    action: {
      type: "observation",
      summary: "Publish to linkedin failed",
      payload: { problem: true, agentId: "linkedin", error: "429" },
    },
  });

function db(rows: ApprovalRow[]): Supabase {
  return { async listApprovals() { return rows; } } as unknown as Supabase;
}

describe("a channel where every post waits for the owner", () => {
  it("learns from the post rulings, not just the growth ideas", async () => {
    const { record, backfilled } = await absorbVerdicts(
      db([publishRow("a", "executed"), publishRow("b", "rejected"), growthRow("a series")]),
      "linkedin",
      emptyRecord(NOW),
      NOW,
      GATED
    );

    expect(backfilled).toBe(3);
    expect(record.episodes.filter((e) => e.kind === "draft")).toHaveLength(2);
    expect(record.episodes.filter((e) => e.kind === "growth_idea")).toHaveLength(1);
  });

  it("keeps the owner's yes and no on the copy itself", async () => {
    const { record } = await absorbVerdicts(
      db([publishRow("a", "executed"), publishRow("b", "rejected")]),
      "linkedin",
      emptyRecord(NOW),
      NOW,
      GATED
    );
    const drafts = record.episodes.filter((e) => e.kind === "draft");
    expect(drafts.filter((e) => e.verdict === "approved")).toHaveLength(1);
    expect(drafts.filter((e) => e.verdict === "rejected")).toHaveLength(1);
  });

  it("gives a publish episode the features a draft actually varies by", async () => {
    // Pillar and format, not risk — a growth idea varies by risk, a post does
    // not have one. A key that is constant across a batch is not a comparable.
    const { record } = await absorbVerdicts(
      db([publishRow("a", "executed")]),
      "linkedin",
      emptyRecord(NOW),
      NOW,
      GATED
    );
    expect(record.episodes[0]?.features).toEqual({
      pillar: "channel-dependency",
      format: "short-post",
      channel: "linkedin",
    });
  });

  it("does not count a connector failure as a ruling", async () => {
    // The owner clearing a 429 is not a judgement about the writing. This is
    // excluded without a special case: a problem escalation carries
    // action.type "observation", which is in neither map.
    const { record, backfilled } = await absorbVerdicts(
      db([problemRow()]),
      "linkedin",
      emptyRecord(NOW),
      NOW,
      GATED
    );
    expect(backfilled).toBe(0);
    expect(record.episodes).toHaveLength(0);
  });
});

describe("a channel where publishing is routine", () => {
  it("still ignores publishes, because nobody ruled on them", async () => {
    // On X a publish executes without a decision. Recording it would create an
    // episode that never resolves and pushes real evidence out of the ring.
    const { record, backfilled } = await absorbVerdicts(
      db([
        { ...publishRow("a", "executed"), agent_id: "x" } as ApprovalRow,
        { ...growthRow("a series"), agent_id: "x" } as ApprovalRow,
      ]),
      "x",
      emptyRecord(NOW),
      NOW,
      UNGATED
    );

    expect(backfilled).toBe(1);
    expect(record.episodes[0]?.kind).toBe("growth_idea");
  });
});

describe("the wiring", () => {
  it("keys the behaviour off the approval gate, not the channel name", () => {
    // Turning the gate on for a third channel must start collecting its post
    // rulings automatically. A hardcoded "linkedin" here would silently not.
    expect(channelAgentSource).toMatch(/spec\.approveBeforePublish\s*\n?\s*\?\s*\{\s*publish_post/);
    expect(channelAgentSource).not.toMatch(/=== "linkedin"[\s\S]{0,80}publish_post/);
  });

  it("has learning on for LinkedIn and the gate that makes it meaningful", () => {
    expect(linkedInSource).toMatch(/learning: true/);
    expect(linkedInSource).toMatch(/approveBeforePublish: true/);
  });

  it("leaves both agents' audience data switched off", () => {
    // The half that must NOT move yet. A model handed past posts and asked what
    // worked will find a pattern; with no engagement signal it is about nothing.
    expect(channelAgentSource).toMatch(/const HAS_AUDIENCE_DATA = false/);
  });

  it("still has X learning from its rulings", () => {
    expect(xAgent.id).toBe("x");
    expect(linkedInAgent.id).toBe("linkedin");
  });
});

describe("buildFeatures", () => {
  it("omits a key the payload does not carry, rather than writing unknown", () => {
    expect(buildFeatures({ risk: "low" }, "x")).toEqual({ risk: "low", channel: "x" });
  });

  it("keeps growth-idea features exactly as they were", () => {
    // The existing X record was built with { risk, channel }. Changing that
    // shape would make old and new episodes incomparable inside one lesson.
    expect(Object.keys(buildFeatures({ risk: "high", title: "t" }, "x")).sort()).toEqual([
      "channel",
      "risk",
    ]);
  });
});
