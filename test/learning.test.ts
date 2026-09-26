// The learning layer's arithmetic: what it keeps, what it joins, what it drops.
//
// Everything asserted here is deliberately pure — no database, no model. The
// value of this layer is entirely in whether it forgets correctly, and forgetting
// is the part that is easy to get wrong and impossible to notice in production:
// a set of lessons that only grows produces plausible drafts right up until the
// prompt is mostly stale rules. So the demotion cases below matter more than the
// accumulation ones.

import { describe, expect, it } from "vitest";
import {
  applyVerdicts,
  confidence,
  demote,
  emptyRecord,
  learningContext,
  LESSON_SALIENCE,
  LESSON_STALE_DAYS,
  lessonId,
  MAX_EPISODES,
  mergeLessons,
  promptLessons,
  PROMPT_LESSONS,
  recordEpisodes,
  resolvedEpisodes,
  shouldForm,
  verdictOf,
  BROADCAST_FLOOR,
  type Episode,
} from "../src/core/learning.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function episode(key: string, extra: Partial<Episode> = {}): Episode {
  return {
    at: NOW.toISOString(),
    key,
    kind: "growth_idea",
    summary: `idea ${key}`,
    features: { risk: "low", channel: "x" },
    ...extra,
  };
}

describe("episodes", () => {
  it("keeps the ring bounded, dropping the oldest", () => {
    let record = emptyRecord(NOW);
    const many = Array.from({ length: MAX_EPISODES + 15 }, (_, i) => episode(`k${i}`));
    record = recordEpisodes(record, many, NOW);

    expect(record.episodes).toHaveLength(MAX_EPISODES);
    // The newest survive; the first fifteen are gone.
    expect(record.episodes[0]?.key).toBe("k15");
    expect(record.episodes.at(-1)?.key).toBe(`k${MAX_EPISODES + 14}`);
  });

  it("does not record the same proposal twice", () => {
    // A strategist wakes hourly. Without this, one idea that stays on the shelf
    // for a day becomes twenty-four episodes and drowns out everything else.
    let record = emptyRecord(NOW);
    record = recordEpisodes(record, [episode("same")], NOW);
    record = recordEpisodes(record, [episode("same"), episode("other")], NOW);

    expect(record.episodes.map((e) => e.key)).toEqual(["same", "other"]);
  });
});

describe("verdicts", () => {
  it("treats an executed approval as approved", () => {
    // "executed" is what "approved" becomes once the action runs. The owner
    // ruled once and the ruling is the same either way.
    expect(verdictOf("approved")).toBe("approved");
    expect(verdictOf("executed")).toBe("approved");
    expect(verdictOf("rejected")).toBe("rejected");
  });

  it("does not treat a failed execution as a rejection", () => {
    // The owner said yes and the machinery broke. Counting that as a rejection
    // would teach the agent to stop proposing things that were approved — it
    // would be learning about the connector while believing it learned about
    // the owner.
    expect(verdictOf("failed")).toBeNull();
    expect(verdictOf("pending")).toBeNull();
    expect(verdictOf(undefined)).toBeNull();
  });

  it("joins rulings onto the episodes that earned them", () => {
    let record = emptyRecord(NOW);
    record = recordEpisodes(record, [episode("a"), episode("b"), episode("c")], NOW);

    const { record: next, resolved } = applyVerdicts(
      record,
      [
        { key: "a", status: "approved", decidedAt: "2026-08-28T09:00:00.000Z" },
        { key: "b", status: "rejected", decidedAt: "2026-08-28T10:00:00.000Z" },
        { key: "c", status: "pending" },
      ],
      NOW
    );

    expect(resolved).toBe(2);
    expect(next.episodes[0]?.verdict).toBe("approved");
    expect(next.episodes[0]?.verdictAt).toBe("2026-08-28T09:00:00.000Z");
    expect(next.episodes[1]?.verdict).toBe("rejected");
    expect(next.episodes[2]?.verdict).toBeUndefined();
    expect(resolvedEpisodes(next)).toHaveLength(2);
  });

  it("does not re-count a ruling it has already absorbed", () => {
    // absorbVerdicts runs on every drafting run and reads the same approvals
    // table each time. If a settled ruling counted again it would trip the
    // formation gate every run, which is the model call this design exists to
    // ration.
    let record = emptyRecord(NOW);
    record = recordEpisodes(record, [episode("a")], NOW);
    const rulings = [{ key: "a", status: "approved" }];

    const first = applyVerdicts(record, rulings, NOW);
    const second = applyVerdicts(first.record, rulings, NOW);

    expect(first.resolved).toBe(1);
    expect(second.resolved).toBe(0);
    expect(second.record.pendingVerdicts).toBe(1);
  });

  it("only pays for a formation call once enough rulings have piled up", () => {
    const record = emptyRecord(NOW);
    expect(shouldForm({ ...record, pendingVerdicts: 1 })).toBe(false);
    expect(shouldForm({ ...record, pendingVerdicts: 4 })).toBe(false);
    expect(shouldForm({ ...record, pendingVerdicts: 5 })).toBe(true);
  });
});

describe("lessons", () => {
  it("treats a rephrased claim as the same lesson", () => {
    // The intelligence layer's settled list stored one fact twice because it
    // matched whole strings and the model rephrases every cycle. Same fix here.
    expect(lessonId("The owner rejects high-risk growth ideas")).toBe(
      lessonId("the owner rejects high risk growth ideas!")
    );
    expect(lessonId("The owner rejects high-risk ideas")).not.toBe(
      lessonId("The owner approves low-risk ideas")
    );
  });

  it("strengthens a re-derived claim rather than replacing it", () => {
    let record = emptyRecord(NOW);
    record = mergeLessons(
      record,
      [{ claim: "High-risk ideas are rejected", basis: "3 rulings", support: 3, contradict: 0 }],
      new Date("2026-07-01T00:00:00.000Z")
    );
    const firstSeen = record.lessons[0]?.firstSeen;

    record = mergeLessons(
      record,
      [{ claim: "high risk ideas are rejected", basis: "5 rulings", support: 2, contradict: 1 }],
      NOW
    );

    expect(record.lessons).toHaveLength(1);
    expect(record.lessons[0]?.support).toBe(5);
    expect(record.lessons[0]?.contradict).toBe(1);
    // The history is what makes a long-standing lesson outrank a new one.
    expect(record.lessons[0]?.firstSeen).toBe(firstSeen);
    expect(record.lessons[0]?.lastConfirmed).toBe(NOW.toISOString());
  });

  it("resets the formation gate once lessons are formed", () => {
    let record = { ...emptyRecord(NOW), pendingVerdicts: 9 };
    record = mergeLessons(record, [{ claim: "x", basis: "y", support: 2, contradict: 0 }], NOW);
    expect(record.pendingVerdicts).toBe(0);
    expect(record.lastFormedAt).toBe(NOW.toISOString());
  });

  it("drops a claim contradicted at least as often as it is supported", () => {
    // A coin flip quoted as guidance is worse than no guidance: it reads as
    // established and costs prompt space that a real lesson would use.
    let record = emptyRecord(NOW);
    record = mergeLessons(
      record,
      [
        { claim: "kept", basis: "b", support: 4, contradict: 1 },
        { claim: "coin flip", basis: "b", support: 3, contradict: 3 },
        { claim: "wrong", basis: "b", support: 1, contradict: 4 },
      ],
      NOW
    );
    record = demote(record, NOW);

    expect(record.lessons.map((l) => l.claim)).toEqual(["kept"]);
  });

  it("drops a claim nothing has confirmed lately", () => {
    let record = emptyRecord(NOW);
    record = mergeLessons(record, [{ claim: "stale", basis: "b", support: 9, contradict: 0 }], NOW);
    record.lessons[0]!.lastConfirmed = new Date(
      NOW.getTime() - (LESSON_STALE_DAYS + 1) * 86_400_000
    ).toISOString();

    expect(demote(record, NOW).lessons).toHaveLength(0);
  });

  it("orders by confidence, then by weight of evidence", () => {
    let record = emptyRecord(NOW);
    record = mergeLessons(
      record,
      [
        { claim: "certain but thin", basis: "b", support: 2, contradict: 0 },
        { claim: "certain and heavy", basis: "b", support: 9, contradict: 0 },
        { claim: "mostly right", basis: "b", support: 8, contradict: 2 },
      ],
      NOW
    );

    expect(promptLessons(record).map((l) => l.claim)).toEqual([
      "certain and heavy",
      "certain but thin",
      "mostly right",
    ]);
  });

  it("scores no evidence as no confidence", () => {
    expect(
      confidence({
        id: "x",
        claim: "x",
        basis: "b",
        support: 0,
        contradict: 0,
        firstSeen: NOW.toISOString(),
        lastConfirmed: NOW.toISOString(),
      })
    ).toBe(0);
  });

  it("caps what reaches a prompt", () => {
    let record = emptyRecord(NOW);
    record = mergeLessons(
      record,
      Array.from({ length: 9 }, (_, i) => ({
        claim: `claim number ${i}`,
        basis: "b",
        support: 9 - i,
        contradict: 0,
      })),
      NOW
    );
    expect(promptLessons(record)).toHaveLength(PROMPT_LESSONS);
  });
});

describe("the prompt block", () => {
  it("says plainly that there is no audience data", () => {
    // The whole point. Handed past posts and asked what worked, a model will
    // find a pattern, because that is what it is for — and with no engagement
    // signal the pattern is about nothing. Saying so is what stops a confident
    // rule forming on an absence.
    const text = learningContext(emptyRecord(NOW), false);
    expect(text).toMatch(/NO audience-response data/);
    expect(text).toMatch(/not in anyone's response to it/);
  });

  it("drops that paragraph once audience data exists", () => {
    const text = learningContext(emptyRecord(NOW), true);
    expect(text).not.toMatch(/NO audience-response data/);
  });

  it("admits to holding nothing rather than padding", () => {
    expect(learningContext(emptyRecord(NOW), false)).toMatch(/nothing established yet/);
  });

  it("shows the evidence behind each claim", () => {
    // A claim whose basis nobody can check is the failure this design is
    // guarding against, so the counts travel with the claim into the prompt.
    let record = emptyRecord(NOW);
    record = mergeLessons(
      record,
      [{ claim: "High-risk ideas are rejected", basis: "b", support: 4, contradict: 1 }],
      NOW
    );
    const text = learningContext(record, false);
    expect(text).toMatch(/High-risk ideas are rejected/);
    expect(text).toMatch(/4 for, 1 against/);
  });
});

describe("the retrieval floor", () => {
  it("keeps lessons below the salience other agents read at", () => {
    // Not a style preference. Growth-Strategy and Chief-of-Staff both read
    // memory at minSalience 6 with no tag filter, so a lesson written at 6 would
    // land in both of their prompts on every run — the broadcast mistake the
    // intelligence layer already designed around. test/learning-retrieval.test.ts
    // asserts the other half: that those two readers still read at this floor.
    expect(LESSON_SALIENCE).toBeLessThan(BROADCAST_FLOOR);
  });
});
