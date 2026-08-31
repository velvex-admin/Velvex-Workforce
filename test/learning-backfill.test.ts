// The rulings that were already on file when the learning layer shipped.
//
// `applyVerdicts` joins a ruling onto an episode the agent recorded when it made
// the proposal. That is the right join, and it has one consequence nobody
// intended: on the day the layer ships the record is empty, so every ruling the
// owner has ever made joins to nothing and is dropped. On X that was nine real
// rulings — eight approvals and a rejection — sitting in `pending_approvals`
// with the whole original action still attached, while the agent waited to
// accumulate five new ones from scratch.
//
// Twice over, in fact. Those historical keys look like
// `x:growth:x:Structural replies to operator threads describing a scaling`,
// with no trailing content hash, because they predate the hash `dedupeKey` now
// appends. So even a re-proposal of the identical idea would have produced a
// different key and still not matched.
//
// The rows below are the real ones, read out of the live Worker on 2026-08-30,
// down to the truncated dedupe keys and the risk of "high" on every idea.

import { describe, expect, it } from "vitest";
import { absorbVerdicts } from "../src/core/learning-store.js";
import { emptyRecord, recordEpisodes, shouldForm, type Episode } from "../src/core/learning.js";
import type { ApprovalRow } from "../src/lib/supabase.js";
import type { Supabase } from "../src/lib/supabase.js";

const NOW = new Date("2026-08-30T12:00:00Z");

const SPEC = {
  kinds: { campaign_direction: "growth_idea" } as const,
  channel: "x",
};

function growth(title: string, status: ApprovalRow["status"], decidedAt: string): ApprovalRow {
  return {
    agent_id: "x",
    agent_batch: "marketing",
    title: `x growth idea: ${title}`,
    rationale: "why this is worth trying",
    trigger_rule: "general.new_by_type",
    risk: "high",
    status,
    // Truncated at 60 chars and with no content hash, exactly as stored.
    dedupe_key: `x:growth:x:${title}`.slice(0, 71),
    decided_at: decidedAt,
    action: {
      type: "campaign_direction",
      summary: `x growth idea: ${title}`,
      channel: "x",
      payload: { title, why: "structural", risk: "high", growthExperiment: true },
    },
  } as ApprovalRow;
}

/** The nine growth rulings, plus the two publish escalations that sit beside them. */
const LIVE_ROWS: ApprovalRow[] = [
  growth("Structural replies to operator threads describing a scaling stall", "executed", "2026-08-21T11:09:45.046Z"),
  growth("One failure mechanic per category: roasters, agencies, single-integration SaaS", "executed", "2026-08-21T11:09:51.555Z"),
  growth("Filing-sourced structural reads on disclosed dependencies", "executed", "2026-08-21T11:10:37.816Z"),
  growth("Quote-post structural reads on public diligence and allocator commentary", "executed", "2026-08-21T10:57:16.198Z"),
  growth("Publish findings in the observed / inference / assumption tagging format", "executed", "2026-08-21T10:57:23.98Z"),
  growth("Seven-system series: one post per system, one failure mechanic each", "executed", "2026-08-21T10:57:35.379Z"),
  growth("Structural reads on public capital-allocator and diligence commentary", "executed", "2026-08-21T02:43:19.451Z"),
  growth("Redacted Ledger fragment as a case-note format, one dimension only", "executed", "2026-08-21T02:43:31.277Z"),
  growth("Pressure Point series: one named mechanism per post", "rejected", "2026-08-21T02:43:57.23Z"),
  {
    agent_id: "x",
    agent_batch: "marketing",
    title: "Publish to x failed",
    rationale: "connector error",
    trigger_rule: "general.problem",
    status: "executed",
    dedupe_key: "problem:x:Publish to x: A 12% discount approved by a rep...:2026-08-22",
    decided_at: "2026-08-22T16:31:37.564Z",
    action: { type: "publish_post", summary: "Publish to x failed", channel: "x", payload: {} },
  } as ApprovalRow,
  {
    agent_id: "linkedin",
    agent_batch: "marketing",
    title: "linkedin growth idea: not ours",
    rationale: "another agent's ruling",
    trigger_rule: "general.new_by_type",
    status: "executed",
    dedupe_key: "linkedin:growth:linkedin:Something else entirely",
    decided_at: "2026-08-21T09:00:00Z",
    action: {
      type: "campaign_direction",
      summary: "linkedin growth idea",
      channel: "linkedin",
      payload: { title: "Something else entirely", risk: "low" },
    },
  } as ApprovalRow,
];

function fakeDb(rows: ApprovalRow[] = LIVE_ROWS): Supabase {
  return { async listApprovals() { return rows; } } as unknown as Supabase;
}

describe("rulings made before the learning layer existed", () => {
  it("are recovered into the record instead of being dropped", async () => {
    const { record, backfilled, resolved } = await absorbVerdicts(
      fakeDb(), "x", emptyRecord(NOW), NOW, SPEC
    );

    // Nothing to JOIN to: the record had no episodes at all.
    expect(resolved).toBe(0);
    expect(backfilled).toBe(9);
    expect(record.episodes).toHaveLength(9);
    expect(record.episodes.every((e) => e.verdict)).toBe(true);
  });

  it("carries the verdicts the owner actually gave", async () => {
    const { record } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);

    expect(record.episodes.filter((e) => e.verdict === "approved")).toHaveLength(8);
    expect(record.episodes.filter((e) => e.verdict === "rejected")).toHaveLength(1);
  });

  it("takes only this agent's own rulable proposals", async () => {
    // An escalated publish is a proposal the agent DID make, and it is still
    // not evidence about judgement: the owner was clearing a connector failure,
    // not ruling on an idea. LinkedIn's rulings are not X's evidence either.
    // Both sit in the same table and a looser filter takes both.
    const { record } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);

    expect(record.episodes.some((e) => e.key.startsWith("problem:"))).toBe(false);
    expect(record.episodes.some((e) => e.key.startsWith("linkedin:"))).toBe(false);
  });

  it("reconstructs the same feature shape the live path records", async () => {
    // A lesson generalises over features. If a back-filled episode carried a
    // different key set from a live one, the model would be generalising over
    // two shapes and could form a claim about the difference between them.
    const { record } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);

    for (const episode of record.episodes) {
      expect(Object.keys(episode.features).sort()).toEqual(["channel", "risk"]);
      expect(episode.features["channel"]).toBe("x");
    }
    // And nothing marks them as back-filled, which would be a feature that
    // correlates perfectly with "historical" and invites a spurious rule.
    expect(JSON.stringify(record.episodes)).not.toMatch(/backfill/i);
  });

  it("dates each episode from when the owner decided, not from this run", async () => {
    const { record } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);
    expect(record.episodes.every((e) => e.at.startsWith("2026-08-21"))).toBe(true);
  });

  it("makes the first run form lessons instead of waiting weeks", async () => {
    const { record } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);
    expect(record.pendingVerdicts).toBe(9);
    expect(shouldForm(record)).toBe(true);
  });

  it("does not add them again on the next run", async () => {
    // The back-fill has to be idempotent or the ring fills with copies and
    // pendingVerdicts climbs forever, paying for a formation call every run.
    const first = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW, SPEC);
    const second = await absorbVerdicts(fakeDb(), "x", first.record, NOW, SPEC);

    expect(second.backfilled).toBe(0);
    expect(second.record.episodes).toHaveLength(9);
    expect(second.record.pendingVerdicts).toBe(first.record.pendingVerdicts);
  });

  it("does not double-count a proposal the agent already logged itself", async () => {
    // The normal path: the agent recorded the episode when it proposed, and the
    // ruling arrives later. That must resolve through applyVerdicts, not be
    // reconstructed alongside it.
    const key = LIVE_ROWS[0]!.dedupe_key!;
    const live: Episode = {
      at: "2026-08-21T11:00:00Z",
      key,
      kind: "growth_idea",
      summary: "already logged",
      features: { risk: "high", channel: "x" },
    };
    const seeded = recordEpisodes(emptyRecord(NOW), [live], NOW);

    const { record, resolved, backfilled } = await absorbVerdicts(fakeDb(), "x", seeded, NOW, SPEC);

    expect(resolved).toBe(1);
    expect(backfilled).toBe(8);
    expect(record.episodes).toHaveLength(9);
    expect(record.episodes.filter((e) => e.key === key)).toHaveLength(1);
    // The agent's own record of it wins; the reconstruction does not overwrite it.
    expect(record.episodes.find((e) => e.key === key)?.summary).toBe("already logged");
  });

  it("stays off entirely when no spec is passed", async () => {
    // Every other agent gets the old behaviour untouched.
    const { record, backfilled } = await absorbVerdicts(fakeDb(), "x", emptyRecord(NOW), NOW);
    expect(backfilled).toBe(0);
    expect(record.episodes).toHaveLength(0);
  });
});
