// Competitive intelligence: the document, the watchlist, and the arithmetic
// that turns a fetched page into evidence of change.
//
// Two ideas hold this file together.
//
// 1. A brief is a DOCUMENT, not a note. It has a fixed shape, it is stored
//    whole, and it can be rendered to Markdown or a standalone page and read
//    months later. That shape is `IntelBrief` and it is what the library
//    stores. Anything the agent wants to say has to fit one of these fields,
//    which is what stops a "brief" from degenerating into a paragraph of
//    impressions.
//
// 2. Every claim carries its evidence standard. Velvex sells a diagnostic that
//    tags each finding as observed fact, inference or assumption, and refuses
//    to hide an assumption. An intelligence agent that guessed at a competitor
//    and stated it flatly would be off-standard in exactly the way the business
//    says it never is, so `EvidenceStandard` is a required field on every
//    finding rather than an optional flourish.
//
// Nothing in this file calls a model or a network. It is the vocabulary and the
// pure functions, so both are testable without either.

// ---------------------------------------------------------------------------
// The watchlist: what the agent is asked to keep an eye on.
// ---------------------------------------------------------------------------

/** Why a source is on the list, which is also what the agent reads it for. */
export type SourceKind =
  /** A direct or adjacent competitor's own pages. */
  | "competitor"
  /** Category-defining language: analyst pages, category explainers, indexes. */
  | "category"
  /** Adjacent tooling that shapes how founders talk about their own business. */
  | "adjacent_tooling"
  /** Where buyers and allocators describe the problem in their own words. */
  | "buyer_language";

export interface IntelSource {
  /** Stable handle. Used as the snapshot key, so renaming a label is free. */
  id: string;
  label: string;
  url: string;
  kind: SourceKind;
  /** What the owner wants watched on this page specifically. */
  note?: string;
}

export interface IntelWatchlist {
  updatedAt: string;
  sources: IntelSource[];
}

/**
 * What we last saw at a source, so "the language moved" is a comparison rather
 * than a recollection. Text is kept, not just the hash: a diff nobody can read
 * is not evidence.
 */
export interface SourceSnapshot {
  fetchedAt: string;
  /** Cheap change detector. Content-derived, so it survives a redeploy. */
  fingerprint: string;
  /** Normalised visible text, capped. */
  text: string;
  status: number;
  ok: boolean;
}

export type SourceSnapshotMap = Record<string, SourceSnapshot>;

/** One source, compared against the last time we looked at it. */
export interface SourceChange {
  sourceId: string;
  label: string;
  url: string;
  kind: SourceKind;
  /** "first_seen" the first time; nothing to compare against yet. */
  state: "first_seen" | "unchanged" | "changed" | "unreachable";
  bytesBefore: number;
  bytesAfter: number;
  /** Sentences present now that were not there before. */
  added: string[];
  /** Sentences that were there before and are gone. */
  removed: string[];
  status: number;
}

// ---------------------------------------------------------------------------
// The brief itself.
// ---------------------------------------------------------------------------

/** Velvex's own evidence standard, applied to Velvex's own intelligence. */
export type EvidenceStandard = "observed" | "inferred" | "assumption";

export interface CategoryLanguageShift {
  /** The term being tracked, e.g. "scale readiness". */
  term: string;
  /** What moved: who is using it, how the meaning has shifted, what replaced it. */
  movement: string;
  evidence: string;
  standard: EvidenceStandard;
}

export interface CompetitorMove {
  who: string;
  /** What they changed, in one sentence. */
  change: string;
  evidence: string;
  standard: EvidenceStandard;
  /** How much this actually threatens Velvex's position, not how loud it is. */
  significance: "low" | "medium" | "high";
}

export interface PositioningGap {
  /** The position nobody currently occupies, named as a position. */
  gap: string;
  /** Why it is open: who vacated it, who cannot credibly claim it, why. */
  whyOpen: string;
  /** Why Velvex could hold it, given what Velvex actually is and sells. */
  velvexFit: string;
  /** Concretely what occupying it would require. No "consider positioning". */
  whatItWouldTake: string;
  standard: EvidenceStandard;
}

export interface DifferentiationSignal {
  /** The Velvex differentiator in question. */
  claim: string;
  /** What is eroding it, or who is starting to claim the same ground. */
  pressure: string;
  /** Where and how to reinforce it. Specific surface, specific wording change. */
  reinforcement: string;
  standard: EvidenceStandard;
}

/**
 * What Velvex actually is, in the owner's own words, as of now.
 *
 * This exists because of a specific failure mode. The agent reads the outside
 * world, and the outside world is out of date about a young company: it will
 * find that a framework was unvalidated, that a price was different, that a
 * claim had not been made yet, and it will report those as observed facts
 * because on the page it read, they are. A brief that tells the owner something
 * about their own business that stopped being true months ago costs them
 * attention and credibility in the same stroke.
 *
 * So the owner keeps a standing statement here, and it OUTRANKS anything the
 * agent infers from the web. Not "consider this too": where the two conflict,
 * this wins and the brief says the public record is stale. The agent is reading
 * the market, not auditing Velvex.
 *
 * It grows two ways: the owner edits it directly, and every question the agent
 * asks that the owner answers is appended to it, so the loop compounds instead
 * of asking the same thing every cycle.
 */
export interface PositionStatement {
  updatedAt: string;
  /** Free prose: what is true now, what has changed, what is no longer true. */
  standing: string;
  /** Answered questions, newest last. Each one is a fact the agent now holds. */
  answers: Array<{
    askedOn: string;
    question: string;
    answer: string;
    answeredAt: string;
  }>;
}

/**
 * The one question this brief would most like answered.
 *
 * A brief is written from outside. Some of what it could not establish is not
 * on any page: it is in the owner's head. Asking exactly one question per cycle
 * makes the intelligence loop two-way without turning it into a form to fill
 * in, and the answer becomes durable context that every later brief reads.
 */
export interface OpenQuestion {
  /** One question. Answerable in a few sentences, not an essay. */
  question: string;
  /** Why the agent cannot answer it from the outside. */
  whyItCannotBeAnswered: string;
  /** What a good answer would change about the next brief. */
  whatItWouldChange: string;
}

export interface BriefSource {
  url: string;
  title?: string;
  /** Which part of the brief this source supports. */
  usedFor?: string;
}

/**
 * One brief. This is the stored document, and the shape the reader in the
 * dashboard renders.
 */
export interface IntelBrief {
  /** Assigned by the database. Absent before it is written. */
  id?: string;
  /** ISO date the brief covers, which is also its handle in conversation. */
  briefDate: string;
  title: string;
  /**
   * The whole brief in one paragraph. Written last, read first: if the owner
   * reads nothing else, this is the thing they read.
   */
  headline: string;

  categoryLanguage: CategoryLanguageShift[];
  competitorMoves: CompetitorMove[];
  positioningGaps: PositioningGap[];
  differentiationToReinforce: DifferentiationSignal[];

  /** What to look at next cycle, so a brief compounds instead of restarting. */
  watchNext: string[];
  /** What could not be established, stated rather than papered over. */
  limitations: string;

  /**
   * The one thing the agent wants to ask the owner. Null when the cycle raised
   * nothing worth their time: a question asked for the sake of asking trains
   * the owner to ignore the question.
   */
  openQuestion: OpenQuestion | null;

  sources: BriefSource[];

  /** Provenance, filled in by the agent rather than the model. */
  meta: {
    generatedAt: string;
    /** Watchlist sources that actually changed since last time. */
    sourcesChanged: number;
    sourcesWatched: number;
    webResearch: boolean;
    searchesUsed: number;
    model: string;
    costUsd: number;
  };
}

/**
 * Field caps. The API rejects `maxItems` inside an output schema (it 400s
 * before the model runs, which is how drafting silently broke on all three
 * channel strategists), so array limits live here and are enforced in the
 * prompt and again in code after parsing. See test/schema-constraints.test.ts.
 */
export const BRIEF_LIMITS = {
  categoryLanguage: 5,
  competitorMoves: 6,
  positioningGaps: 4,
  differentiationToReinforce: 4,
  watchNext: 6,
  sources: 25,
} as const;

const EVIDENCE_VALUES: EvidenceStandard[] = ["observed", "inferred", "assumption"];

/**
 * The structured-output schema for the composing call.
 *
 * Deliberately free of array length constraints: `maxItems`, `minItems`,
 * `uniqueItems` and `patternProperties` are all rejected by the Messages API
 * inside `output_config.format.schema`. Caps are stated in the prompt and
 * applied by `clampBrief()` after parsing.
 */
export const BRIEF_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "headline",
    "categoryLanguage",
    "competitorMoves",
    "positioningGaps",
    "differentiationToReinforce",
    "watchNext",
    "limitations",
    "openQuestion",
    "sources",
  ],
  properties: {
    title: { type: "string" },
    headline: { type: "string" },
    categoryLanguage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "movement", "evidence", "standard"],
        properties: {
          term: { type: "string" },
          movement: { type: "string" },
          evidence: { type: "string" },
          standard: { type: "string", enum: EVIDENCE_VALUES },
        },
      },
    },
    competitorMoves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["who", "change", "evidence", "standard", "significance"],
        properties: {
          who: { type: "string" },
          change: { type: "string" },
          evidence: { type: "string" },
          standard: { type: "string", enum: EVIDENCE_VALUES },
          significance: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    positioningGaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["gap", "whyOpen", "velvexFit", "whatItWouldTake", "standard"],
        properties: {
          gap: { type: "string" },
          whyOpen: { type: "string" },
          velvexFit: { type: "string" },
          whatItWouldTake: { type: "string" },
          standard: { type: "string", enum: EVIDENCE_VALUES },
        },
      },
    },
    differentiationToReinforce: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "pressure", "reinforcement", "standard"],
        properties: {
          claim: { type: "string" },
          pressure: { type: "string" },
          reinforcement: { type: "string" },
          standard: { type: "string", enum: EVIDENCE_VALUES },
        },
      },
    },
    watchNext: { type: "array", items: { type: "string" } },
    limitations: { type: "string" },
    // Nullable: a cycle that raised nothing worth the owner's time asks
    // nothing. A question asked to fill the field trains them to skip it.
    openQuestion: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["question", "whyItCannotBeAnswered", "whatItWouldChange"],
      properties: {
        question: { type: "string" },
        whyItCannotBeAnswered: { type: "string" },
        whatItWouldChange: { type: "string" },
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          usedFor: { type: "string" },
        },
      },
    },
  },
};

/** The model's half of a brief: everything except the provenance we own. */
export type ComposedBrief = Omit<IntelBrief, "id" | "briefDate" | "meta">;

/** Apply the array caps the schema is not allowed to state. */
export function clampBrief(brief: ComposedBrief): ComposedBrief {
  return {
    ...brief,
    categoryLanguage: (brief.categoryLanguage ?? []).slice(0, BRIEF_LIMITS.categoryLanguage),
    competitorMoves: (brief.competitorMoves ?? []).slice(0, BRIEF_LIMITS.competitorMoves),
    positioningGaps: (brief.positioningGaps ?? []).slice(0, BRIEF_LIMITS.positioningGaps),
    differentiationToReinforce: (brief.differentiationToReinforce ?? []).slice(
      0,
      BRIEF_LIMITS.differentiationToReinforce
    ),
    watchNext: (brief.watchNext ?? []).slice(0, BRIEF_LIMITS.watchNext),
    sources: (brief.sources ?? []).slice(0, BRIEF_LIMITS.sources),
    openQuestion: brief.openQuestion ?? null,
  };
}

// ---------------------------------------------------------------------------
// The owner's standing position, and the loop that keeps it current.
// ---------------------------------------------------------------------------

/** How many answered questions are carried into a prompt. The newest matter most. */
export const POSITION_ANSWER_WINDOW = 12;

export function emptyPosition(now: Date): PositionStatement {
  return { updatedAt: now.toISOString(), standing: "", answers: [] };
}

/**
 * The position statement, written for a model to read as authoritative.
 *
 * The framing here is the whole point. Handed to a model as neutral background
 * it would be weighed against whatever the web said and sometimes lose, which
 * is exactly the failure this is meant to prevent. It is handed over as a
 * correction with precedence, and the prompts say so again.
 */
export function positionContext(position: PositionStatement | null): string {
  if (!position || (!position.standing.trim() && position.answers.length === 0)) {
    return (
      "No standing position statement has been recorded. Anything you find about Velvex " +
      "on the open web may be out of date, and you cannot tell which parts. Treat every " +
      "such finding as unverified, say so, and do not describe Velvex's own maturity, " +
      "validation or capability as though the public record settled it."
    );
  }

  const parts: string[] = [];
  if (position.standing.trim()) {
    parts.push(
      `What is true about Velvex now, stated by the owner:\n${position.standing.trim()}`
    );
  }

  const answers = position.answers.slice(-POSITION_ANSWER_WINDOW);
  if (answers.length > 0) {
    const asked = answers
      .map((entry) => `- Q (${entry.askedOn}): ${entry.question}\n  A: ${entry.answer}`)
      .join("\n");
    parts.push(
      "Questions this agent asked in earlier cycles, and the owner's answers. These are " +
        `settled. Do not ask them again.\n${asked}`
    );
  }

  parts.push(
    "This statement outranks anything you find on the open web about Velvex itself. Where " +
      "a page contradicts it, the page is stale: say that the public record is out of date " +
      "rather than reporting the stale version as a finding. You are reading the market, " +
      "not auditing Velvex."
  );

  return parts.join("\n\n");
}

/** Record an answered question, newest last, bounded. */
export function recordAnswer(
  position: PositionStatement | null,
  entry: { askedOn: string; question: string; answer: string },
  now: Date
): PositionStatement {
  const base = position ?? emptyPosition(now);
  return {
    ...base,
    updatedAt: now.toISOString(),
    answers: [
      ...base.answers,
      { ...entry, answeredAt: now.toISOString() },
    ].slice(-60),
  };
}

/**
 * True when a brief actually found something. A brief with no gaps, no moves
 * and no language shifts is a run that came back empty, and saying so is more
 * useful than filing an empty document as though it were a finding.
 */
export function briefIsSubstantive(brief: ComposedBrief): boolean {
  return (
    (brief.categoryLanguage?.length ?? 0) +
      (brief.competitorMoves?.length ?? 0) +
      (brief.positioningGaps?.length ?? 0) +
      (brief.differentiationToReinforce?.length ?? 0) >
    0
  );
}

// ---------------------------------------------------------------------------
// Reading a page. No parser: a Worker has no DOM, and for language monitoring
// the visible prose is the whole point.
// ---------------------------------------------------------------------------

/** How much normalised text we keep per source. Enough to diff, bounded. */
export const SNAPSHOT_TEXT_CAP = 20_000;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

/**
 * Visible text from an HTML document, normalised so that whitespace-only
 * changes and reordered attributes do not read as a language shift.
 *
 * Script, style, noscript and template contents are dropped entirely: a
 * changed analytics snippet is not the competitor changing their message, and
 * treating it as one would make every snapshot look different every week.
 */
export function extractText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Block-level tags become sentence breaks so the diff lands on real units.
    .replace(/<\/(p|div|h[1-6]|li|section|article|header|footer|tr|blockquote)>/gi, ". ")
    .replace(/<br\s*\/?>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim()
    .slice(0, SNAPSHOT_TEXT_CAP);
}

/**
 * A stable content fingerprint. FNV-1a rather than a crypto hash: this detects
 * change, it does not defend against anyone crafting a collision, and it is
 * synchronous where SubtleCrypto is not.
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + ":" + text.length.toString(16);
}

/** Split normalised text into comparable units. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 25);
}

/** How many added/removed lines a single change reports. Beyond this is noise. */
const DIFF_LINE_CAP = 8;

/**
 * Compare one source against what we last stored for it.
 *
 * The comparison is set-based on sentences rather than positional: a page that
 * reorders its sections has not changed its language, and a positional diff
 * would claim it rewrote everything.
 */
export function diffSource(
  source: IntelSource,
  fetched: SourceSnapshot,
  previous: SourceSnapshot | undefined
): SourceChange {
  const base = {
    sourceId: source.id,
    label: source.label,
    url: source.url,
    kind: source.kind,
    bytesBefore: previous?.text.length ?? 0,
    bytesAfter: fetched.text.length,
    status: fetched.status,
  };

  if (!fetched.ok) {
    return { ...base, state: "unreachable", added: [], removed: [] };
  }
  if (!previous || !previous.ok) {
    return { ...base, state: "first_seen", added: [], removed: [] };
  }
  if (previous.fingerprint === fetched.fingerprint) {
    return { ...base, state: "unchanged", added: [], removed: [] };
  }

  const before = new Set(sentences(previous.text));
  const after = new Set(sentences(fetched.text));

  const added = [...after].filter((line) => !before.has(line)).slice(0, DIFF_LINE_CAP);
  const removed = [...before].filter((line) => !after.has(line)).slice(0, DIFF_LINE_CAP);

  // A fingerprint can move on whitespace the normaliser did not catch. If no
  // whole sentence moved, nothing worth reading changed.
  if (added.length === 0 && removed.length === 0) {
    return { ...base, state: "unchanged", added: [], removed: [] };
  }

  return { ...base, state: "changed", added, removed };
}

// ---------------------------------------------------------------------------
// The standing questions. These are the three the owner named, written as
// research questions rather than keywords so the model has something to answer
// rather than something to match.
// ---------------------------------------------------------------------------

export const STANDING_QUESTIONS: readonly string[] = [
  'How is the phrase "business health" being used right now by the people who sell assessments, scorecards and diagnostics to founders, and what does it appear to mean to them?',
  'Who is claiming "scale readiness" as a category, what do they say it measures, and is the term hardening into a standard or being diluted?',
  "What language do investors and acquirers currently use for operational and commercial due diligence on a company below institutional size, and which parts of that language have moved in the last quarter?",
  "Which providers are positioning a bounded, fixed-price, third-party diagnostic rather than an open-ended advisory engagement, and how do they describe the boundary?",
  "Where is the founder-tooling market putting the word 'audit', and is it being used for something structural or for something superficial?",
] as const;

// ---------------------------------------------------------------------------
// Rendering. The owner asked to be able to save and read these, so a brief has
// to leave the database as something readable.
// ---------------------------------------------------------------------------

const STANDARD_LABEL: Record<EvidenceStandard, string> = {
  observed: "observed",
  inferred: "inferred",
  assumption: "assumption",
};

function bullet(lines: string[]): string {
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "_Nothing this cycle._";
}

/** A brief as Markdown. This is the download format. */
export function renderBriefMarkdown(brief: IntelBrief): string {
  const out: string[] = [];

  out.push(`# ${brief.title}`);
  out.push("");
  out.push(`**Velvex competitive intelligence brief — ${brief.briefDate}**`);
  out.push("");
  out.push(brief.headline);
  out.push("");

  out.push("## Category language");
  out.push("");
  out.push(
    bullet(
      brief.categoryLanguage.map(
        (item) =>
          `**${item.term}** (${STANDARD_LABEL[item.standard]}): ${item.movement}\n  Evidence: ${item.evidence}`
      )
    )
  );
  out.push("");

  out.push("## Competitor and adjacent moves");
  out.push("");
  out.push(
    bullet(
      brief.competitorMoves.map(
        (item) =>
          `**${item.who}** — significance ${item.significance} (${STANDARD_LABEL[item.standard]}): ${item.change}\n  Evidence: ${item.evidence}`
      )
    )
  );
  out.push("");

  out.push("## Positioning gaps Velvex could occupy");
  out.push("");
  out.push(
    bullet(
      brief.positioningGaps.map(
        (item) =>
          `**${item.gap}** (${STANDARD_LABEL[item.standard]})\n` +
          `  Why it is open: ${item.whyOpen}\n` +
          `  Why Velvex fits: ${item.velvexFit}\n` +
          `  What it would take: ${item.whatItWouldTake}`
      )
    )
  );
  out.push("");

  out.push("## Differentiation to reinforce");
  out.push("");
  out.push(
    bullet(
      brief.differentiationToReinforce.map(
        (item) =>
          `**${item.claim}** (${STANDARD_LABEL[item.standard]})\n` +
          `  Under pressure from: ${item.pressure}\n` +
          `  Reinforce by: ${item.reinforcement}`
      )
    )
  );
  out.push("");

  out.push("## Watch next cycle");
  out.push("");
  out.push(bullet(brief.watchNext));
  out.push("");

  if (brief.openQuestion) {
    out.push("## The question this brief is asking you");
    out.push("");
    out.push(`**${brief.openQuestion.question}**`);
    out.push("");
    out.push(`Why it cannot be answered from outside: ${brief.openQuestion.whyItCannotBeAnswered}`);
    out.push("");
    out.push(`What your answer would change: ${brief.openQuestion.whatItWouldChange}`);
    out.push("");
  }

  out.push("## Limitations");
  out.push("");
  out.push(brief.limitations || "_None stated._");
  out.push("");

  out.push("## Sources");
  out.push("");
  out.push(
    bullet(
      brief.sources.map(
        (source) =>
          `[${source.title || source.url}](${source.url})${source.usedFor ? ` — ${source.usedFor}` : ""}`
      )
    )
  );
  out.push("");

  out.push("---");
  out.push("");
  out.push(
    `Generated ${brief.meta.generatedAt} · ${brief.meta.sourcesChanged} of ${brief.meta.sourcesWatched} watched sources changed · ` +
      `web research ${brief.meta.webResearch ? `on, ${brief.meta.searchesUsed} searches` : "off"} · ` +
      `${brief.meta.model} · $${brief.meta.costUsd.toFixed(4)}`
  );
  out.push("");
  out.push(
    "Findings are tagged observed, inferred or assumption, to the same evidence standard Velvex applies to a client Ledger."
  );

  return out.join("\n");
}

/** Escape for embedding in HTML. Used by the standalone-page renderer. */
export function escapeHtml(value: string): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );
}

/**
 * A brief as a standalone HTML page, styled to match the dashboard so a saved
 * file does not look like a different product from the one that produced it.
 */
export function renderBriefHtml(brief: IntelBrief): string {
  const section = (heading: string, body: string) =>
    `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`;

  const empty = `<p class="empty">Nothing this cycle.</p>`;

  const tag = (standard: EvidenceStandard) =>
    `<span class="tag ${escapeHtml(standard)}">${escapeHtml(STANDARD_LABEL[standard])}</span>`;

  const categoryLanguage = brief.categoryLanguage.length
    ? brief.categoryLanguage
        .map(
          (item) =>
            `<article><h3>${escapeHtml(item.term)} ${tag(item.standard)}</h3>` +
            `<p>${escapeHtml(item.movement)}</p>` +
            `<p class="ev"><b>Evidence.</b> ${escapeHtml(item.evidence)}</p></article>`
        )
        .join("")
    : empty;

  const competitorMoves = brief.competitorMoves.length
    ? brief.competitorMoves
        .map(
          (item) =>
            `<article><h3>${escapeHtml(item.who)} ${tag(item.standard)}` +
            `<span class="sig sig-${escapeHtml(item.significance)}">${escapeHtml(item.significance)}</span></h3>` +
            `<p>${escapeHtml(item.change)}</p>` +
            `<p class="ev"><b>Evidence.</b> ${escapeHtml(item.evidence)}</p></article>`
        )
        .join("")
    : empty;

  const gaps = brief.positioningGaps.length
    ? brief.positioningGaps
        .map(
          (item) =>
            `<article class="gap"><h3>${escapeHtml(item.gap)} ${tag(item.standard)}</h3>` +
            `<p class="ev"><b>Why it is open.</b> ${escapeHtml(item.whyOpen)}</p>` +
            `<p class="ev"><b>Why Velvex fits.</b> ${escapeHtml(item.velvexFit)}</p>` +
            `<p class="ev"><b>What it would take.</b> ${escapeHtml(item.whatItWouldTake)}</p></article>`
        )
        .join("")
    : empty;

  const differentiation = brief.differentiationToReinforce.length
    ? brief.differentiationToReinforce
        .map(
          (item) =>
            `<article><h3>${escapeHtml(item.claim)} ${tag(item.standard)}</h3>` +
            `<p class="ev"><b>Under pressure from.</b> ${escapeHtml(item.pressure)}</p>` +
            `<p class="ev"><b>Reinforce by.</b> ${escapeHtml(item.reinforcement)}</p></article>`
        )
        .join("")
    : empty;

  const question = brief.openQuestion
    ? `<article class="ask"><h3>${escapeHtml(brief.openQuestion.question)}</h3>` +
      `<p class="ev"><b>Why it cannot be answered from outside.</b> ${escapeHtml(
        brief.openQuestion.whyItCannotBeAnswered
      )}</p>` +
      `<p class="ev"><b>What your answer would change.</b> ${escapeHtml(
        brief.openQuestion.whatItWouldChange
      )}</p></article>`
    : `<p class="empty">Nothing this cycle needed asking.</p>`;

  const watchNext = brief.watchNext.length
    ? `<ul>${brief.watchNext.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
    : empty;

  const sources = brief.sources.length
    ? `<ol class="sources">${brief.sources
        .map(
          (source) =>
            `<li><a href="${escapeHtml(source.url)}" rel="noreferrer noopener">${escapeHtml(
              source.title || source.url
            )}</a>${source.usedFor ? ` <span class="ev">${escapeHtml(source.usedFor)}</span>` : ""}</li>`
        )
        .join("")}</ol>`
    : empty;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(brief.title)} — Velvex intelligence brief</title>
<style>
:root{--bg:#0F1218;--surface:#1B1F2A;--border:#2A2F3B;--text:#EDEAE2;--dim:#9297A6;--faint:#5C6170;--cyan:#4FC3D9}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.65;padding:48px 20px 80px}
main{max-width:760px;margin:0 auto}
.kicker{font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);margin-bottom:10px}
h1{font-family:Georgia,serif;font-size:30px;font-weight:600;letter-spacing:-.015em;margin-bottom:8px}
.date{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.07em;margin-bottom:26px}
.headline{font-size:17px;color:var(--text);border-left:2px solid var(--cyan);padding-left:18px;margin-bottom:38px}
h2{font-family:ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--cyan);margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
h3{font-size:15.5px;font-weight:600;margin-bottom:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
article{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:16px 18px;margin-bottom:12px}
article.gap{border-left:3px solid var(--cyan)}
article.ask{border-left:3px solid #C98A3E;background:rgba(201,138,62,.07)}
article.ask h3{color:#C98A3E}
p{margin-bottom:8px}
p:last-child{margin-bottom:0}
.ev{font-size:13.5px;color:var(--dim)}
.ev b{color:var(--faint);font-weight:600}
.tag{font-family:ui-monospace,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:20px;border:1px solid;font-weight:500}
.tag.observed{color:#6FA787;border-color:rgba(111,167,135,.45)}
.tag.inferred{color:#7597C4;border-color:rgba(117,151,196,.45)}
.tag.assumption{color:#C98A3E;border-color:rgba(201,138,62,.45)}
.sig{font-family:ui-monospace,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.sig-high{color:#C1666B}
.sig-medium{color:#C98A3E}
ul,ol{padding-left:22px;color:var(--dim)}
li{margin-bottom:6px}
a{color:var(--cyan)}
.empty{color:var(--faint);font-style:italic}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--border);font-family:ui-monospace,monospace;font-size:10.5px;color:var(--faint);line-height:1.8}
</style>
</head>
<body>
<main>
  <div class="kicker">Velvex · Competitive intelligence</div>
  <h1>${escapeHtml(brief.title)}</h1>
  <div class="date">${escapeHtml(brief.briefDate)}</div>
  <p class="headline">${escapeHtml(brief.headline)}</p>
  ${section("Category language", categoryLanguage)}
  ${section("Competitor and adjacent moves", competitorMoves)}
  ${section("Positioning gaps Velvex could occupy", gaps)}
  ${section("Differentiation to reinforce", differentiation)}
  ${section("The question this brief is asking you", question)}
  ${section("Watch next cycle", watchNext)}
  ${section("Limitations", `<p class="ev">${escapeHtml(brief.limitations || "None stated.")}</p>`)}
  ${section("Sources", sources)}
  <footer>
    Generated ${escapeHtml(brief.meta.generatedAt)} ·
    ${brief.meta.sourcesChanged} of ${brief.meta.sourcesWatched} watched sources changed ·
    web research ${brief.meta.webResearch ? `on, ${brief.meta.searchesUsed} searches` : "off"} ·
    ${escapeHtml(brief.meta.model)} · $${brief.meta.costUsd.toFixed(4)}<br>
    Findings are tagged observed, inferred or assumption, to the same evidence standard Velvex applies to a client Ledger.
  </footer>
</main>
</body>
</html>`;
}

/** Filename for a downloaded brief. */
export function briefFilename(brief: IntelBrief, extension: "md" | "html"): string {
  return `velvex-intel-${brief.briefDate}.${extension}`;
}
