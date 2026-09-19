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
  candidateId,
  candidateIsOpen,
  cooldownRemainingDays,
  DISCOVERY_SCHEMA,
  normaliseUrl,
  recordVerdict,
  REJECTION_COOLDOWN_DAYS,
  briefIsSubstantive,
  briefFilename,
  clampBrief,
  diffSource,
  extractText,
  fingerprint,
  positionContext,
  POSITION_ANSWER_WINDOW,
  recordAnswer,
  renderBriefHtml,
  renderBriefMarkdown,
  sentences,
  SNAPSHOT_TEXT_CAP,
  type CandidateLedger,
  type ComposedBrief,
  type IntelBrief,
  type IntelSource,
  type PositionStatement,
  type SourceSnapshot,
  mergeSettled,
  MAX_SETTLED,
  recheckUrls,
  MAX_RECHECK_URLS,
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
  openQuestion: {
    question: "Has the Vela scoring framework been validated against completed engagements?",
    whyItCannotBeAnswered: "Nothing published states it either way.",
    whatItWouldChange: "Whether 'defensible scoring' can be claimed as held ground.",
  },
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

// ---------------------------------------------------------------------------
// The standing position, and the loop that keeps it current.
//
// This is the answer to a specific failure: the agent reads the open web, the
// open web is stale about a young company, and a brief that reports "the
// framework is unvalidated" to an owner who validated it months ago has spent
// their attention to tell them something false about their own business.
// ---------------------------------------------------------------------------

describe("the standing position statement", () => {
  const position: PositionStatement = {
    updatedAt: "2026-08-24T00:00:00.000Z",
    standing: "The Vela scoring framework was validated against completed engagements in June.",
    answers: [
      {
        askedOn: "2026-08-17",
        question: "Has the framework been validated?",
        answer: "Yes, internally, against completed engagements.",
        answeredAt: "2026-08-18T09:00:00.000Z",
      },
    ],
  };

  it("hands the statement over as authoritative, not as background", () => {
    // The framing is the whole mechanism. Offered as neutral context it would
    // be weighed against whatever the web said and would sometimes lose, which
    // is precisely what this exists to prevent.
    const context = positionContext(position);
    expect(context).toContain("outranks");
    expect(context).toContain("validated against completed engagements in June");
    expect(context).toContain("reading the market, not auditing Velvex");
  });

  it("carries answered questions so the same one is not asked twice", () => {
    const context = positionContext(position);
    expect(context).toContain("Has the framework been validated?");
    expect(context).toContain("Do not ask them again");
  });

  it("tells the agent to distrust the public record when nothing is on file", () => {
    for (const empty of [null, { updatedAt: "x", standing: "   ", answers: [] }]) {
      const context = positionContext(empty as PositionStatement | null);
      expect(context).toContain("may be out of date");
      expect(context).toContain("unverified");
    }
  });

  it("only carries the most recent answers into a prompt", () => {
    const many: PositionStatement = {
      ...position,
      answers: Array.from({ length: POSITION_ANSWER_WINDOW + 8 }, (_, i) => ({
        askedOn: `2026-01-${String(i + 1).padStart(2, "0")}`,
        question: `question ${i}`,
        answer: `answer ${i}`,
        answeredAt: "2026-01-01T00:00:00.000Z",
      })),
    };
    const context = positionContext(many);
    expect(context).not.toContain("question 0");
    expect(context).toContain(`question ${POSITION_ANSWER_WINDOW + 7}`);
  });
});

describe("recording an answer", () => {
  const now = new Date("2026-08-24T10:00:00.000Z");
  const entry = { askedOn: "2026-08-24", question: "Q?", answer: "A." };

  it("starts a position from nothing when there is none yet", () => {
    const next = recordAnswer(null, entry, now);
    expect(next.answers).toHaveLength(1);
    expect(next.answers[0]!.answeredAt).toBe(now.toISOString());
    expect(next.standing).toBe("");
  });

  it("appends without disturbing the standing prose", () => {
    const current: PositionStatement = {
      updatedAt: "old",
      standing: "Validated in June.",
      answers: [
        { askedOn: "a", question: "q1", answer: "a1", answeredAt: "t1" },
      ],
    };
    const next = recordAnswer(current, entry, now);
    expect(next.standing).toBe("Validated in June.");
    expect(next.answers.map((a) => a.question)).toEqual(["q1", "Q?"]);
  });

  it("keeps the record bounded so it cannot grow without limit", () => {
    let position: PositionStatement | null = null;
    for (let i = 0; i < 80; i += 1) {
      position = recordAnswer(position, { ...entry, question: `q${i}` }, now);
    }
    expect(position!.answers.length).toBeLessThanOrEqual(60);
    // The newest survive; the oldest fall off.
    expect(position!.answers.at(-1)!.question).toBe("q79");
  });
});

describe("the question a brief asks", () => {
  it("is a required schema field that may be null", () => {
    const properties = (BRIEF_SCHEMA as any).properties;
    expect((BRIEF_SCHEMA as any).required).toContain("openQuestion");
    // Nullable on purpose: a cycle with nothing worth asking must be able to
    // ask nothing. Forcing a question every week teaches the owner to skip it.
    expect(properties.openQuestion.type).toEqual(["object", "null"]);
  });

  it("survives a model that returned no question at all", () => {
    const clamped = clampBrief({ title: "t", headline: "h" } as unknown as ComposedBrief);
    expect(clamped.openQuestion).toBeNull();
  });

  it("reaches both the Markdown and the page renderer", () => {
    expect(renderBriefMarkdown(fullBrief)).toContain("The question this brief is asking you");
    expect(renderBriefMarkdown(fullBrief)).toContain("Vela scoring framework");
    expect(renderBriefHtml(fullBrief)).toContain("Vela scoring framework");
  });

  it("says so plainly when a brief asked nothing", () => {
    const quiet = renderBriefMarkdown({ ...fullBrief, openQuestion: null });
    expect(quiet).toContain("## Limitations");
    expect(quiet).not.toContain("The question this brief is asking you");
  });
});

// ---------------------------------------------------------------------------
// The discovery gate.
//
// Nothing reaches the watchlist until the owner has said it should. The part
// that has to be right is the suppression: a rejection that silently expires
// early puts a decision back in front of someone who already made it, and a
// rejection whose clock restarts every week turns a 180 day cooldown into a
// permanent ban nobody chose.
// ---------------------------------------------------------------------------

const now = new Date("2026-08-24T00:00:00.000Z");
const rival = { name: "Rival Diagnostics", url: "https://rival.example/assessment" };

describe("identifying a candidate", () => {
  it("derives a stable id from a name or a URL", () => {
    expect(candidateId("Rival Diagnostics")).toBe("rival-diagnostics");
    expect(candidateId("https://www.Rival.example/Assessment/")).toBe("rival-example-assessment");
  });

  it("treats spellings of one page as one page", () => {
    // Otherwise accepting a candidate twice would create two watchlist entries
    // for the same URL, and each snapshot would report the other as a rewrite.
    const forms = [
      "https://rival.example/assessment",
      "https://www.rival.example/assessment/",
      "HTTPS://Rival.Example/Assessment",
    ];
    expect(new Set(forms.map(normaliseUrl)).size).toBe(1);
  });
});

describe("whether a candidate may be put to the owner", () => {
  const watched = [
    { id: "watched", label: "Already watched", url: "https://watched.example/", kind: "category" as const },
  ];

  it("opens a candidate nobody has ruled on", () => {
    expect(candidateIsOpen(rival, {}, [], now)).toBe(true);
  });

  it("never re-proposes something already being watched", () => {
    expect(
      candidateIsOpen({ name: "Whatever", url: "https://www.watched.example" }, {}, watched, now)
    ).toBe(false);
  });

  it("never re-proposes something already accepted", () => {
    const ledger = recordVerdict({}, { ...rival, verdict: "accepted" }, now);
    expect(candidateIsOpen(rival, ledger, [], now)).toBe(false);
  });

  it("suppresses a rejection for the full cooldown and not a day less", () => {
    const ledger = recordVerdict({}, { ...rival, verdict: "rejected" }, now);
    const dayBefore = new Date(now.getTime() + (REJECTION_COOLDOWN_DAYS - 1) * 86_400_000);
    const dayAfter = new Date(now.getTime() + (REJECTION_COOLDOWN_DAYS + 1) * 86_400_000);

    expect(candidateIsOpen(rival, ledger, [], dayBefore)).toBe(false);
    // A market moves. "Not a competitor" is a statement about now, not about
    // always, so the rejection expires rather than being permanent.
    expect(candidateIsOpen(rival, ledger, [], dayAfter)).toBe(true);
  });

  it("recognises a rejected candidate that comes back under a new name", () => {
    // The whole point of the cooldown. Discovery re-finds the same page every
    // week and will happily describe it differently each time.
    const ledger = recordVerdict({}, { ...rival, verdict: "rejected" }, now);
    const renamed = { name: "Rival Diagnostics Inc (formerly Rival)", url: rival.url };
    expect(candidateIsOpen(renamed, ledger, [], now)).toBe(false);
  });

  it("counts down the days left rather than only saying blocked", () => {
    const ledger = recordVerdict({}, { ...rival, verdict: "rejected" }, now);
    const verdict = ledger[candidateId(rival.name)]!;
    expect(cooldownRemainingDays(verdict, now)).toBe(REJECTION_COOLDOWN_DAYS);
    expect(
      cooldownRemainingDays(verdict, new Date(now.getTime() + 179 * 86_400_000))
    ).toBe(1);
    expect(
      cooldownRemainingDays(verdict, new Date(now.getTime() + 400 * 86_400_000))
    ).toBe(0);
  });

  it("puts no expiry on an acceptance", () => {
    const ledger = recordVerdict({}, { ...rival, verdict: "accepted" }, now);
    const verdict = ledger[candidateId(rival.name)]!;
    expect(verdict.suppressedUntil).toBeUndefined();
    expect(cooldownRemainingDays(verdict, now)).toBe(0);
  });

  it("keeps earlier rulings when a new one is recorded", () => {
    let ledger: CandidateLedger = recordVerdict({}, { ...rival, verdict: "rejected" }, now);
    ledger = recordVerdict(
      ledger,
      { name: "Other Co", url: "https://other.example/", verdict: "accepted" },
      now
    );
    expect(Object.keys(ledger)).toHaveLength(2);
    expect(ledger[candidateId(rival.name)]!.verdict).toBe("rejected");
  });
});

describe("the discovery schema", () => {
  it("states no array length constraint, which the API rejects", () => {
    expect(JSON.stringify(DISCOVERY_SCHEMA)).not.toContain("maxItems");
  });

  it("makes the quiet-week decision a required field", () => {
    // If this were optional a missing value would read as falsy, and every week
    // would silently become a quiet week with no brief.
    expect((DISCOVERY_SCHEMA as any).required).toContain("anythingMaterial");
    expect((DISCOVERY_SCHEMA as any).required).toContain("quietNote");
  });

  it("requires evidence and a standard on every candidate", () => {
    const item = (DISCOVERY_SCHEMA as any).properties.candidates.items;
    expect(item.required).toContain("evidence");
    expect(item.required).toContain("standard");
    expect(item.required).toContain("url");
  });
});

describe("settled findings, the memory that subtracts", () => {
  it("puts this cycle's findings in front of the older ones", () => {
    expect(mergeSettled(["old one"], ["new one"])).toEqual(["new one", "old one"]);
  });

  it("does not grow without bound", () => {
    // The whole point. Carrying open questions forward was additive and took
    // the research pass from $0.6601 to $1.1838 in one cycle. A settled list
    // that grew the same way would reintroduce the problem it exists to fix.
    const many = Array.from({ length: 40 }, (_, i) => `finding ${i}`);
    expect(mergeSettled([], many)).toHaveLength(MAX_SETTLED);
  });

  it("does not keep the same finding twice, however it is phrased", () => {
    const merged = mergeSettled(["Lumena publishes no price"], ["lumena publishes no price  "]);
    expect(merged).toEqual(["lumena publishes no price"]);
  });

  it("collapses the same fact reworded, which is how it actually arrives", () => {
    // Both of these came back on the second real run and both were stored. The
    // model rephrases the same finding every cycle, so an exact-string match
    // lets one fact occupy the list several times over.
    const a =
      "Let's Level Up (letslevelup.com.au) still sells the $2,500 AUD founder-led diagnostic " +
      "credited toward delivery if the client proceeds";
    const b =
      "Let's Level Up (letslevelup.com.au) still sells the $2,500 AUD founder-led diagnostic " +
      "credited toward the delivery engagement";
    expect(mergeSettled([a], [b])).toHaveLength(1);
  });

  it("still keeps two genuinely different findings apart", () => {
    const a = "Lumena Global publishes no price for the operational readiness assessment";
    const b = "For The TECH Of It still sells the $1,497 diagnostic on 7-10 business days";
    expect(mergeSettled([a], [b])).toHaveLength(2);
  });

  it("drops empty lines rather than storing them", () => {
    expect(mergeSettled([], ["", "   ", "real"])).toEqual(["real"]);
  });
});

describe("the pages the scan is allowed to re-read", () => {
  const watched = [
    { id: "a", label: "A", url: "https://rival.example/pricing", kind: "competitor" as const },
  ];
  const previous = [
    { url: "https://forthetechofit.com/book-a-diagnostic" },
    { url: "https://valuebuildersystem.com/eight-drivers" },
  ];

  it("hands over real URLs, because web_fetch cannot use a company name", () => {
    // The measured failure: the scan was given the last brief's headline, which
    // names companies in prose. web_fetch only retrieves URLs already in the
    // conversation, so every fetch call failed and the scan verified one
    // provider of five before reporting that nothing had moved.
    const urls = recheckUrls(watched, previous);
    expect(urls).toContain("https://forthetechofit.com/book-a-diagnostic");
    expect(urls.every((url) => /^https?:\/\//.test(url))).toBe(true);
  });

  it("leaves out the watchlist, which the run has already fetched itself", () => {
    // The second measured failure. Watchlist pages come back with a real diff
    // computed without a model and without a budget, so offering them here made
    // the scan spend all four fetches re-reading what was already in its prompt
    // and hit "server tool use limit exceeded" before reaching anything else.
    expect(recheckUrls(watched, previous)).not.toContain("https://rival.example/pricing");
  });

  it("drops a previous source that has since been accepted onto the watchlist", () => {
    const nowWatched = [
      {
        id: "ftoi",
        label: "FTOI",
        url: "https://forthetechofit.com/book-a-diagnostic",
        kind: "competitor" as const,
      },
    ];
    expect(recheckUrls(nowWatched, previous)).toEqual([
      "https://valuebuildersystem.com/eight-drivers",
    ]);
  });

  it("does not list the same page twice under two spellings", () => {
    const dupes = [
      { url: "https://forthetechofit.com/book-a-diagnostic" },
      { url: "https://WWW.ForTheTechOfIt.com/book-a-diagnostic/" },
    ];
    expect(recheckUrls([], dupes)).toHaveLength(1);
  });

  it("drops anything that is not a fetchable URL", () => {
    const junk = [{ url: "Level Up Professional Services" }, { url: "" }, { url: "mailto:a@b.c" }];
    expect(recheckUrls([], junk)).toEqual([]);
  });

  it("stays bounded, since the scan has a small fetch budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://e${i}.example/p` }));
    expect(recheckUrls([], many)).toHaveLength(MAX_RECHECK_URLS);
  });

  it("copes with a brief that recorded no sources", () => {
    expect(recheckUrls(watched, undefined)).toEqual([]);
  });
});
