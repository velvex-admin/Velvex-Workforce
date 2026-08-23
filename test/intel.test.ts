// The intelligence layer's arithmetic and its document.
//
// Everything here is the half of the agent that has no model in it: reading a
// page, deciding whether its language actually moved, capping the arrays the
// output schema is not allowed to cap, and turning a brief into something the
// owner can save. That half is where a quiet wrong answer would do the most
// damage, because a false "this changed" sends an expensive Opus pass chasing
// a whitespace edit, and a missed one loses the only first-hand evidence a
// brief has.

import { describe, expect, it } from "vitest";
import {
  BRIEF_LIMITS,
  BRIEF_SCHEMA,
  briefIsSubstantive,
  briefFilename,
  clampBrief,
  diffSource,
  extractText,
  fingerprint,
  renderBriefHtml,
  renderBriefMarkdown,
  sentences,
  SNAPSHOT_TEXT_CAP,
  type ComposedBrief,
  type IntelBrief,
  type IntelSource,
  type SourceSnapshot,
} from "../src/core/intel.js";
import { topMove } from "../src/agents/intelligence/competitive-intel.js";

const source: IntelSource = {
  id: "rival-home",
  label: "Rival — homepage",
  url: "https://example.com/",
  kind: "competitor",
};

function snapshot(text: string, overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    fetchedAt: "2026-08-23T00:00:00.000Z",
    fingerprint: fingerprint(text),
    text,
    status: 200,
    ok: true,
    ...overrides,
  };
}

describe("reading a page", () => {
  it("keeps the visible prose and drops the markup", () => {
    const text = extractText(
      '<html><body><h1>Scale readiness</h1><p>We audit the <b>structure</b>.</p></body></html>'
    );
    expect(text).toContain("Scale readiness");
    expect(text).toContain("We audit the structure");
    expect(text).not.toContain("<");
  });

  it("drops script and style bodies entirely", () => {
    // A changed analytics snippet is not a competitor changing their message.
    // If this leaked through, every snapshot would differ every single week and
    // the diff would be worthless.
    const text = extractText(
      "<body><script>var t=Date.now();gtag('x',t)</script>" +
        "<style>.a{color:red}</style><p>Business health, measured.</p></body>"
    );
    expect(text).toContain("Business health, measured");
    expect(text).not.toContain("gtag");
    expect(text).not.toContain("color:red");
  });

  it("decodes the entities that turn up in real copy", () => {
    expect(extractText("<p>Founders&#39; tooling &amp; diligence</p>")).toContain(
      "Founders' tooling & diligence"
    );
  });

  it("normalises whitespace so reflowed markup does not read as a rewrite", () => {
    const a = extractText("<p>Scale readiness   is    a claim.</p>");
    const b = extractText("<p>Scale\n\n  readiness is a claim.</p>");
    expect(a).toBe(b);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("caps what it stores per source", () => {
    expect(extractText("<p>" + "word ".repeat(20_000) + "</p>").length).toBeLessThanOrEqual(
      SNAPSHOT_TEXT_CAP
    );
  });

  it("gives different text different fingerprints, and the same text the same one", () => {
    expect(fingerprint("scale readiness")).toBe(fingerprint("scale readiness"));
    expect(fingerprint("scale readiness")).not.toBe(fingerprint("scale readyness"));
  });

  it("only treats a long enough run as a comparable sentence", () => {
    // Short fragments are navigation and buttons. Diffing on them would report
    // a change every time a menu item moved.
    const found = sentences("Home. About. We audit the structural dependencies that carry a business.");
    expect(found).toEqual(["We audit the structural dependencies that carry a business."]);
  });
});

describe("deciding whether a source actually moved", () => {
  const before = snapshot(
    "We run a structural diagnostic for founders approaching a raise. " +
      "Every finding is tagged and every assumption is disclosed openly."
  );

  it("calls the first look first_seen rather than a change", () => {
    const change = diffSource(source, before, undefined);
    expect(change.state).toBe("first_seen");
    expect(change.added).toEqual([]);
  });

  it("says unchanged when nothing moved", () => {
    expect(diffSource(source, snapshot(before.text), before).state).toBe("unchanged");
  });

  it("reports the sentences that appeared and the ones that went", () => {
    const after = snapshot(
      "We run a scale readiness assessment for founders approaching a raise. " +
        "Every finding is tagged and every assumption is disclosed openly."
    );
    const change = diffSource(source, after, before);
    expect(change.state).toBe("changed");
    expect(change.added.join(" ")).toContain("scale readiness assessment");
    expect(change.removed.join(" ")).toContain("structural diagnostic");
  });

  it("does not call a reordered page a rewrite", () => {
    // Set comparison, not positional. A page that swaps two sections has not
    // changed a word of its language, and a positional diff would claim it
    // replaced everything.
    const reordered = snapshot(
      "Every finding is tagged and every assumption is disclosed openly. " +
        "We run a structural diagnostic for founders approaching a raise."
    );
    const change = diffSource(source, reordered, before);
    expect(change.added).toEqual([]);
    expect(change.removed).toEqual([]);
    expect(change.state).toBe("unchanged");
  });

  it("treats an unreachable page as unreachable, not as an emptied one", () => {
    const dead = snapshot("", { ok: false, status: 0, fingerprint: "" });
    const change = diffSource(source, dead, before);
    expect(change.state).toBe("unreachable");
    // Critically: it does not claim every sentence was removed.
    expect(change.removed).toEqual([]);
  });

  it("waits for a real reading before comparing, after an outage", () => {
    const previouslyDown = snapshot("", { ok: false, status: 500, fingerprint: "" });
    expect(diffSource(source, snapshot(before.text), previouslyDown).state).toBe("first_seen");
  });
});

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

const fullBrief: IntelBrief = {
  briefDate: "2026-08-24",
  title: "The audit word is being taken",
  headline: "Three adjacent providers moved onto structural language this month.",
  categoryLanguage: [
    {
      term: "scale readiness",
      movement: "Now used for a checklist rather than a structural read.",
      evidence: "Two provider pages reworded it in the last month.",
      standard: "observed",
    },
  ],
  competitorMoves: [
    {
      who: "Rival Diagnostics",
      change: "Dropped the fixed price from the homepage.",
      evidence: "Price block gone from the hero between snapshots.",
      standard: "observed",
      significance: "medium",
    },
  ],
  positioningGaps: [
    {
      gap: "The standard used before a raise, not after a problem",
      whyOpen: "Everyone else sells remediation.",
      velvexFit: "The Ledger is bounded and delivered in 24 hours.",
      whatItWouldTake: "Reword the site hero around the pre-raise moment.",
      standard: "inferred",
    },
  ],
  differentiationToReinforce: [
    {
      claim: "Every finding is tagged observed, inferred or assumption",
      pressure: "Two competitors now say 'evidence-based'.",
      reinforcement: "Put the tagging on the homepage, not only in the FAQ.",
      standard: "observed",
    },
  ],
  watchNext: ["Whether Rival republishes a price"],
  limitations: "Pricing for two providers could not be established.",
  sources: [{ url: "https://example.com/", title: "Rival", usedFor: "pricing" }],
  meta: {
    generatedAt: "2026-08-24T08:00:00.000Z",
    sourcesChanged: 1,
    sourcesWatched: 4,
    webResearch: true,
    searchesUsed: 6,
    model: "claude-opus-5",
    costUsd: 0.4213,
  },
};

describe("the brief's output schema", () => {
  it("states no array length constraint anywhere", () => {
    // The API rejects maxItems inside output_config.format.schema and 400s
    // before the model runs. That is exactly how drafting silently broke on all
    // three channel strategists. test/schema-constraints.test.ts walks this
    // schema too; this asserts the caps live somewhere else instead.
    expect(JSON.stringify(BRIEF_SCHEMA)).not.toContain("maxItems");
    expect(BRIEF_LIMITS.positioningGaps).toBeGreaterThan(0);
  });

  it("requires an evidence standard on every kind of finding", () => {
    const properties = (BRIEF_SCHEMA as any).properties;
    for (const field of [
      "categoryLanguage",
      "competitorMoves",
      "positioningGaps",
      "differentiationToReinforce",
    ]) {
      expect(properties[field].items.required).toContain("standard");
    }
  });
});

describe("capping what the schema cannot cap", () => {
  it("trims every array to its documented limit", () => {
    const overflowing = {
      ...fullBrief,
      positioningGaps: Array.from({ length: 12 }, () => fullBrief.positioningGaps[0]!),
      watchNext: Array.from({ length: 30 }, (_, i) => `item ${i}`),
    } as unknown as ComposedBrief;

    const clamped = clampBrief(overflowing);
    expect(clamped.positioningGaps).toHaveLength(BRIEF_LIMITS.positioningGaps);
    expect(clamped.watchNext).toHaveLength(BRIEF_LIMITS.watchNext);
  });

  it("survives a model that omitted an optional array entirely", () => {
    const partial = { title: "t", headline: "h" } as unknown as ComposedBrief;
    const clamped = clampBrief(partial);
    expect(clamped.competitorMoves).toEqual([]);
    expect(clamped.sources).toEqual([]);
  });

  it("knows the difference between a thin brief and an empty one", () => {
    expect(briefIsSubstantive(fullBrief)).toBe(true);
    expect(
      briefIsSubstantive({
        ...fullBrief,
        categoryLanguage: [],
        competitorMoves: [],
        positioningGaps: [],
        differentiationToReinforce: [],
      })
    ).toBe(false);
  });
});

describe("choosing the one thing that reaches the approvals queue", () => {
  it("puts open ground ahead of held ground", () => {
    const move = topMove(fullBrief);
    expect(move?.kind).toBe("positioning_gap");
  });

  it("falls back to differentiation when no gap was found", () => {
    const move = topMove({ ...fullBrief, positioningGaps: [] });
    expect(move?.kind).toBe("differentiation");
    expect(move?.title).toContain("Reinforce differentiation");
  });

  it("prefers an observed finding to an assumed one", () => {
    const move = topMove({
      ...fullBrief,
      positioningGaps: [
        { ...fullBrief.positioningGaps[0]!, gap: "guessed", standard: "assumption" },
        { ...fullBrief.positioningGaps[0]!, gap: "seen", standard: "observed" },
      ],
    });
    expect(move?.title).toContain("seen");
  });

  it("proposes nothing when the brief found nothing", () => {
    expect(
      topMove({ ...fullBrief, positioningGaps: [], differentiationToReinforce: [] })
    ).toBeNull();
  });
});

describe("taking a brief out of the system", () => {
  it("renders Markdown carrying every section and its evidence tags", () => {
    const markdown = renderBriefMarkdown(fullBrief);
    expect(markdown).toContain("# The audit word is being taken");
    expect(markdown).toContain("## Positioning gaps Velvex could occupy");
    expect(markdown).toContain("The standard used before a raise");
    expect(markdown).toContain("(inferred)");
    expect(markdown).toContain("$0.4213");
    expect(markdown).toContain("https://example.com/");
  });

  it("says a section is empty rather than dropping it", () => {
    const markdown = renderBriefMarkdown({ ...fullBrief, competitorMoves: [] });
    expect(markdown).toContain("## Competitor and adjacent moves");
    expect(markdown).toContain("_Nothing this cycle._");
  });

  it("renders a standalone page and escapes what came from outside", () => {
    const hostile: IntelBrief = {
      ...fullBrief,
      title: '</title><script>alert(1)</script>',
      sources: [{ url: 'https://x.test/"onerror="alert(1)', title: "<img src=x>" }],
    };
    const page = renderBriefHtml(hostile);
    // A brief is composed from text a competitor's page supplied. It is
    // rendered into a page the owner opens, so it is escaped, not trusted.
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).not.toContain("<img src=x>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("<!doctype html>");
  });

  it("names the downloaded file after the cycle it covers", () => {
    expect(briefFilename(fullBrief, "md")).toBe("velvex-intel-2026-08-24.md");
    expect(briefFilename(fullBrief, "html")).toBe("velvex-intel-2026-08-24.html");
  });
});
