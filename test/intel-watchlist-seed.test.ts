// The shipped watchlist seed, checked against the rules the API enforces.
//
// This file is PUT straight at a live Worker. A typo in it does not fail here,
// it fails as a 400 from a running endpoint, several layers away from whoever
// typed it, and a bad `kind` or a malformed URL would sit in the file until
// somebody tried to use it. So the seed is validated as data.
//
// What is NOT asserted here is that the URLs still resolve. That is a network
// fact, it changes without anyone touching this repo, and a test that fails
// because a competitor had an outage would train everyone to ignore it. Each
// URL was fetched with the agent's own User-Agent and run through its own
// extractText() when it was added; the agent reports an unreachable source
// every run thereafter, which is the right place for that signal.

import { describe, expect, it } from "vitest";
import type { IntelSource, SourceKind } from "../src/core/intel.js";
// Imported rather than read off disk: this project types against
// @cloudflare/workers-types only, so node:fs and import.meta.url are correctly
// absent. resolveJsonModule is already on.
import seedJson from "../db/seeds/intel-watchlist.json";

const seed = seedJson as unknown as {
  sources: IntelSource[];
  _rejected: Array<{ url: string; why: string }>;
};

const KINDS: SourceKind[] = ["competitor", "category", "adjacent_tooling", "buyer_language"];

describe("the shipped watchlist seed", () => {
  it("carries sources, within what one run will fetch", () => {
    expect(seed.sources.length).toBeGreaterThan(0);
    // MAX_SOURCES_PER_RUN in the agent. A longer list is not an error, but
    // everything past the cap would silently never be looked at.
    expect(seed.sources.length).toBeLessThanOrEqual(12);
  });

  it.each(seed.sources.map((s) => [s.id, s] as const))(
    "%s passes what the watchlist endpoint validates",
    (_id, source) => {
      expect(source.id).toMatch(/^[a-z0-9-]+$/);
      expect(source.label.trim().length).toBeGreaterThan(0);
      expect(source.url).toMatch(/^https:\/\//);
      expect(KINDS).toContain(source.kind);
    }
  );

  it("has no duplicate ids, which are the snapshot keys", () => {
    // A duplicate id would make two sources share one snapshot, so each would
    // report the other's page as a total rewrite every single week.
    const ids = seed.sources.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tells the agent what to look for on each page", () => {
    // The note is per-source instruction, not decoration: it is what turns
    // "this page changed" into "this page changed in the way that matters".
    for (const source of seed.sources) {
      expect(source.note?.trim().length ?? 0).toBeGreaterThan(40);
    }
  });

  it("classifies scoring tools as category rather than competitor", () => {
    // The owner's read is that nothing in this market matches Velvex, and that
    // is right: these return a number, Velvex returns a structural reading.
    // They are watched because they are where a match would first appear, and
    // filing them as competitors would quietly assert the opposite.
    const competitors = seed.sources.filter((source) => source.kind === "competitor");
    expect(competitors.length).toBeLessThanOrEqual(2);
    expect(seed.sources.filter((source) => source.kind === "category").length).toBeGreaterThan(1);
  });

  it("records why a rejected source was rejected", () => {
    // A source that 403s is worse than no source: it reports "unreachable"
    // every week forever. Keeping the reason stops it being re-added.
    for (const entry of seed._rejected) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.why.trim().length).toBeGreaterThan(20);
    }
  });
});
