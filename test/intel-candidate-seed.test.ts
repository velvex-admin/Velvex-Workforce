// The shipped candidate batch, checked against the rules that consume it.
//
// This file is compiled into the Worker and proposed to the owner a few entries
// at a time. A malformed entry does not fail here, it fails as a queued
// proposal the owner cannot act on, or as a watchlist source that 404s every
// week. So the seed is validated as data.
//
// What is NOT asserted is that the URLs still resolve. That is a network fact,
// it changes without anyone touching this repo, and a suite that goes red
// because a competitor had an outage is a suite people stop believing. Each URL
// was fetched with the agent's own User-Agent and run through its own
// extractText() when it was added; the agent reports an unreachable source on
// every run thereafter, which is the right place for that signal.

import { describe, expect, it } from "vitest";
import {
  candidateId,
  normaliseUrl,
  type SourceKind,
  type WatchCandidate,
} from "../src/core/intel.js";
// Imported rather than read off disk: this project types against
// @cloudflare/workers-types only, so node:fs and import.meta.url are correctly
// absent. resolveJsonModule is already on, and the agent imports it the same way.
import seedJson from "../db/seeds/intel-candidates.json";

const seed = seedJson as unknown as {
  candidates: Array<WatchCandidate & { id: string }>;
  _rejected: Array<{ url: string; why: string }>;
};

const KINDS: SourceKind[] = ["competitor", "category", "adjacent_tooling", "buyer_language"];

describe("the shipped candidate batch", () => {
  it("carries candidates", () => {
    expect(seed.candidates.length).toBeGreaterThan(0);
  });

  it.each(seed.candidates.map((c) => [c.id, c] as const))(
    "%s is shaped so it can be proposed and then watched",
    (_id, candidate) => {
      expect(candidate.name.trim().length).toBeGreaterThan(0);
      expect(candidate.url).toMatch(/^https:\/\//);
      expect(KINDS).toContain(candidate.suggestedKind);
      expect(["observed", "inferred", "assumption"]).toContain(candidate.standard);
      // whyItMightMatch becomes the source note and the rationale the owner
      // reads when deciding. A thin one makes the decision unanswerable.
      expect(candidate.whyItMightMatch.trim().length).toBeGreaterThan(40);
      expect(candidate.evidence.trim().length).toBeGreaterThan(10);
    }
  );

  it("has no two candidates that would collide once accepted", () => {
    // Accepting derives the watchlist id from the name and dedupes on the URL.
    // Two entries colliding on either would share one snapshot key, and each
    // would then report the other's page as a total rewrite every week.
    const ids = seed.candidates.map((candidate) => candidateId(candidate.name));
    expect(new Set(ids).size).toBe(ids.length);
    const urls = seed.candidates.map((candidate) => normaliseUrl(candidate.url));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("leads with the one real competitor", () => {
    // Order is what the owner rules on first, because the batch drains a few
    // per run. If they only ever decide on the first entry, it should be the
    // one that matters.
    expect(seed.candidates[0]!.suggestedKind).toBe("competitor");
    expect(seed.candidates.filter((c) => c.suggestedKind === "competitor").length)
      .toBeLessThanOrEqual(2);
  });

  it("files scoring tools as category rather than competitor", () => {
    // The owner's read is that nothing in this market matches Velvex, and that
    // is right: these return a number, Velvex returns a structural reading.
    // They are proposed because they are where a match would first appear, and
    // filing them as competitors would quietly assert the opposite.
    expect(seed.candidates.filter((c) => c.suggestedKind === "category").length)
      .toBeGreaterThan(1);
  });

  it("records why an unusable source was rejected", () => {
    // A source that 403s is worse than no source: it would report
    // "unreachable" every week forever. Keeping the reason stops a future
    // session re-adding it without checking.
    for (const entry of seed._rejected) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.why.trim().length).toBeGreaterThan(20);
    }
  });
});
