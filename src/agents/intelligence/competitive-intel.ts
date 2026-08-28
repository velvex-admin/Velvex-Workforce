// Competitive Intelligence and Category Positioning Agent — Intelligence.
//
//   Routine        filing a brief into its own library; reporting what moved
//   Needs approval anything it wants the business to actually do
//
// The only agent whose subject is outside this system. Every other agent
// reasons over data we already hold: our reports, our pipeline, our site, our
// posts. This one reads the category — adjacent diagnostics, business
// assessment and founder tooling, and the language investors use for
// commercial due diligence — and asks one question of it: which position is
// nobody holding, and could Velvex hold it credibly.
//
// It is observe-only and it stays that way. It cannot publish, cannot edit the
// site, cannot contact anyone. It writes documents and it makes a case; acting
// on the case is the owner's decision and then somebody else's job.
//
// ---------------------------------------------------------------------------
// Why the run is shaped the way it is
//
// Two passes, deliberately, rather than one clever call.
//
//   Pass 1 (research) has the web tools and no output schema. It goes and
//   looks, and it comes back with prose and a list of pages it actually read.
//
//   Pass 2 (compose) has the schema and no tools. It turns that evidence into
//   the document, and it never touches the network while doing it.
//
// Keeping them apart buys three things. Structured output and server-side
// tools are not made to interact, and this system has already lost a whole
// agent's output to a schema the API rejected before the model ran. A composing
// call that cannot search cannot quietly fill a gap in the evidence with a
// search it then forgets to cite. And the expensive half can be re-run without
// paying for the research again.
//
// Before either pass, the watchlist is fetched and diffed with no model at all.
// That part is arithmetic: we hold what each page said last week, so "their
// language moved" is a comparison against a stored snapshot rather than the
// model's impression of what a page used to say. It is the only evidence in the
// brief that is genuinely first-hand, which is why it is gathered first and put
// in front of the model rather than left for it to reconstruct.

import { BudgetExceededError } from "../../lib/claude.js";
import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";

import { MODELS } from "../../core/models.js";
import { BUSINESS, BUSINESS_CONTEXT } from "../../core/business.js";
import { STATE_KEYS, state } from "../../core/state.js";
import { flag } from "../../env.js";
import SEED from "../../../db/seeds/intel-candidates.json";
import {
  BRIEF_LIMITS,
  BRIEF_SCHEMA,
  candidateId,
  candidateIsOpen,
  DISCOVERY_SCHEMA,
  normaliseUrl,
  recordVerdict,
  REJECTION_COOLDOWN_DAYS,
  briefIsSubstantive,
  clampBrief,
  diffSource,
  extractText,
  fingerprint,
  positionContext,
  STANDING_QUESTIONS,
  type CandidateLedger,
  type ComposedBrief,
  type DiscoveryResult,
  type IntelBrief,
  type IntelSource,
  type IntelWatchlist,
  type PositionStatement,
  type WatchCandidate,
  type SourceChange,
  type SourceSnapshot,
  type SourceSnapshotMap,
  SCAN_SCHEMA,
  mergeSettled,
  recheckUrls,
  type ScanResult,
} from "../../core/intel.js";

const MODEL = MODELS.reasoning;

/** How many of the last brief's open threads are carried into the next run. */
const MAX_CARRIED_QUESTIONS = 3;

/**
 * Per-run ceilings on web access. Searches are billed at $10 per 1,000 on top
 * of the tokens their results consume, so this is a budget as much as a limit:
 * at a weekly cadence these caps put the search line of the bill under $0.50 a
 * month. Raising them is a spend decision.
 */
const MAX_SEARCHES = 8;
const MAX_FETCHES = 5;

/** How many watchlist sources one run will pull. Bounds the run, not the list. */
const MAX_SOURCES_PER_RUN = 12;

/** Per-source fetch timeout. A slow competitor site must not stall the tick. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How many candidates go to the owner in one run.
 *
 * Deliberately small. Every candidate is a separate decision, and a queue that
 * arrives with ten of them is a queue nobody finishes: the same reasoning that
 * caps a brief at one positioning move. The shipped batch drains a few per week
 * until it is exhausted, and discovery then takes over.
 */
const MAX_CANDIDATES_PER_RUN = 4;

/** The researched starting batch, proposed rather than applied. */
const SEED_CANDIDATES: WatchCandidate[] = (
  SEED as unknown as {
    candidates: Array<WatchCandidate & { id: string }>;
  }
).candidates;

// ---------------------------------------------------------------------------
// Watchlist gathering. No model.
// ---------------------------------------------------------------------------

async function fetchSnapshot(url: string, now: Date): Promise<SourceSnapshot> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        // Identify honestly. This reads public pages on a weekly schedule; it
        // is not pretending to be a browser.
        "User-Agent": `Velvex-VX03-Intelligence/1.0 (+${BUSINESS.site})`,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const body = res.ok ? await res.text() : "";
    const text = extractText(body);

    return {
      fetchedAt: now.toISOString(),
      fingerprint: fingerprint(text),
      text,
      status: res.status,
      ok: res.ok && text.length > 0,
    };
  } catch {
    // A network failure is not evidence the page changed. It is recorded as
    // unreachable so the next run compares against the last good snapshot
    // rather than against nothing.
    return { fetchedAt: now.toISOString(), fingerprint: "", text: "", status: 0, ok: false };
  }
}

/**
 * Fetch every watched source and compare it to what we last stored. Returns the
 * changes and the snapshots to persist, without persisting them: nothing is
 * written until the run has actually produced something, so a run that dies
 * halfway does not consume the "this changed" signal for next time.
 */
async function gatherWatchlist(
  watchlist: IntelWatchlist,
  previous: SourceSnapshotMap,
  ctx: RunContext
): Promise<{ changes: SourceChange[]; snapshots: SourceSnapshotMap }> {
  const sources = watchlist.sources.slice(0, MAX_SOURCES_PER_RUN);
  const snapshots: SourceSnapshotMap = { ...previous };
  const changes: SourceChange[] = [];

  for (const source of sources) {
    const fetched = await fetchSnapshot(source.url, ctx.now);
    changes.push(diffSource(source, fetched, previous[source.id]));
    // Only overwrite a stored snapshot with one we actually read. Replacing a
    // good snapshot with an empty one would make next week's diff claim the
    // page was rewritten from scratch.
    if (fetched.ok) snapshots[source.id] = fetched;
  }

  const moved = changes.filter((change) => change.state === "changed").length;
  const down = changes.filter((change) => change.state === "unreachable").length;
  ctx.log(
    `competitive_intel: ${sources.length} watched, ${moved} changed, ${down} unreachable`
  );

  return { changes, snapshots };
}

/** The watchlist diffs, written for a model to read as evidence. */
function describeChanges(changes: SourceChange[]): string {
  if (changes.length === 0) return "(no watchlist configured)";

  return changes
    .map((change) => {
      const head = `- ${change.label} (${change.kind}, ${change.url}) — ${change.state}`;
      if (change.state !== "changed") return head;
      const added = change.added.length
        ? `\n    NEW LANGUAGE:\n${change.added.map((line) => `      "${line}"`).join("\n")}`
        : "";
      const removed = change.removed.length
        ? `\n    REMOVED:\n${change.removed.map((line) => `      "${line}"`).join("\n")}`
        : "";
      return `${head} (${change.bytesBefore} to ${change.bytesAfter} chars)${added}${removed}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pass 1: research.
// ---------------------------------------------------------------------------

const SCAN_SYSTEM = `You are the competitive intelligence scout for Velvex. This is a cheap pass and it has one job: decide whether the expensive pass is worth running this cycle.

You are not writing a brief. You are answering one question. Since the last brief was written, has anything moved that would change what it said?

What counts as movement, and this list is the whole of it:

1. A provider in this category changed price, packaging, turnaround or guarantee. A number that used to be one thing and is now another.
2. A new entrant is selling a bounded, paid diagnostic that ends, rather than a diagnostic that exists to sell delivery work.
3. The category's language moved. A scoring tool that starts saying "structural", "dependency", "load bearing" or "survives scale" has told you something a year before it could deliver it.
4. Buyer-side vocabulary moved. What founders, operators or capital allocators call this kind of assessment when they ask for it.
5. Something contradicts or dates the central claim of the last brief. If the last brief said a position was vacant and somebody has taken it, that is the most important thing you can find.
6. A watched source changed its language, where a diff is given to you below.

What does NOT count, however interesting: blog posts, marketing refreshes, rebrands, funding rounds with no product change, conference talks, hiring, general AI industry news, and anything already listed as settled below.

Rules.

Say somethingMoved false unless you can name the specific thing that moved and where you saw it. "The category is evolving" is not movement. A cycle where nothing moved is the normal case for this category and reporting that honestly is worth more than manufacturing a finding, because a brief every cycle regardless of what happened is how a library stops being read.

If somethingMoved is true, put the specific things worth researching properly into leads. Each lead should name a company, a page or a phrase, not a topic. The expensive pass will read them; do not try to do its job here.

Put into settledNow anything you checked and found unchanged, phrased so a later cycle can skip it: "Lumena still publishes no price", "Value Builder score is still free". This list is how these runs get cheaper over time, so it is worth filling in properly even on a cycle where nothing moved.

Never invent a company, a price or a claim. If you did not see it, it did not happen.`;

function scanPrompt(args: {
  previousBriefDate: string | null;
  previousHeadline: string | null;
  carriedQuestions: string[];
  settled: string[];
  changes: SourceChange[];
  position: PositionStatement | null;
  recheck: string[];
}): string {
  const parts: string[] = [];

  parts.push(
    args.previousBriefDate
      ? `The last brief was written on ${args.previousBriefDate}. You are deciding whether anything has moved since then.`
      : "There is no previous brief. Treat this as a first look at the category."
  );

  if (args.previousHeadline) {
    parts.push(`What the last brief concluded:\n${args.previousHeadline}`);
  }

  if (args.carriedQuestions.length) {
    parts.push(
      `Open threads the last brief said it would check (at most three are carried, deliberately):\n` +
        args.carriedQuestions.map((q) => `- ${q}`).join("\n")
    );
  }

  if (args.settled.length) {
    parts.push(
      `Already settled. Do not spend this pass re-establishing any of these; only report one if it has CHANGED:\n` +
        args.settled.map((line) => `- ${line}`).join("\n")
    );
  }

  if (args.recheck.length) {
    // web_fetch will only retrieve a URL that is already in the conversation,
    // so the pages worth re-reading have to be written out here as URLs. Naming
    // the companies in prose is what left the first scan with nothing it could
    // legally fetch.
    parts.push(
      `Pages worth re-reading, if a search result suggests one of them may have changed. ` +
        `You have a small fetch budget, so spend it on the ones that look different rather ` +
        `than working down the list:\n` +
        args.recheck.map((url) => `- ${url}`).join("\n")
    );
  }

  parts.push(describeChanges(args.changes));
  parts.push(positionContext(args.position));

  return parts.join("\n\n");
}

const RESEARCH_SYSTEM = `You are the competitive intelligence researcher for Velvex.

${BUSINESS_CONTEXT}

Your job this pass is to find out what is actually true right now, not to write anything up. Someone else composes the brief from what you bring back.

Cover four things:

1. Adjacent providers. Who else sells a diagnostic, assessment, scorecard, readiness review or operational audit to businesses at a scaling decision. What they claim, how they bound the engagement, what they charge if it is published, and specifically how they describe the difference between themselves and consulting.
2. Category language. How "business health", "scale readiness" and investor or acquirer due diligence are being phrased right now by the people selling to this buyer. Which terms are hardening into standards, which are being diluted by everyone claiming them, and which have been quietly dropped.
3. Founder tooling. What language the tools founders already use put in front of them about their own business, because that is the vocabulary a buyer arrives with.
4. Movement. Anything that changed recently rather than anything that is merely true.

How to work:

- Search deliberately. You have a small number of searches, so make each one a real question rather than a keyword.
- Read the page before you believe the search snippet. A snippet is a claim about a page, not the page.
- Quote. When a provider words something in a particular way, bring back their words, not your paraphrase.
- Never name a company, a price, a claim or a trend you did not actually see on a page you retrieved. If you could not establish something, say that you could not establish it. An honest gap is worth more here than a confident guess, and a fabricated competitor would put a decision in front of the owner based on nothing.
- Say plainly where the evidence is thin.
- You will be given a standing statement from the owner about what is true of Velvex right now. It outranks the open web on that subject. The public record about a young company goes stale fast, and reporting a stale fact about Velvex back to its own owner as a finding is worse than useless. Where a page you read contradicts the statement, note that the public record is out of date and move on. You are researching the market, not auditing Velvex.

Write it back as notes: dense, specific, quoted where it matters, with the URL beside each claim. No structure requirements, no conclusions, no recommendations. Notes. No em dashes.`;

function researchPrompt(args: {
  changes: SourceChange[];
  carriedQuestions: string[];
  previousHeadline: string | null;
  liveStrategyQuestions: string[];
  position: PositionStatement | null;
}): string {
  const parts: string[] = [];

  // First, and deliberately: the model reads what is actually true of Velvex
  // before it reads anything the outside world says about it.
  parts.push(positionContext(args.position));

  parts.push(
    `Standing questions, asked every cycle:\n${STANDING_QUESTIONS.map((q) => `- ${q}`).join("\n")}`
  );

  if (args.carriedQuestions.length > 0) {
    parts.push(
      `Carried forward from the last brief, answer these first:\n${args.carriedQuestions
        .map((q) => `- ${q}`)
        .join("\n")}`
    );
  }

  if (args.liveStrategyQuestions.length > 0) {
    parts.push(
      `What the Growth-Strategy agent has been weighing lately, in case the category has a bearing on it:\n${args.liveStrategyQuestions
        .map((q) => `- ${q}`)
        .join("\n")}`
    );
  }

  parts.push(
    `Sources on the owner's watchlist, fetched directly this cycle. This is first-hand evidence: it is what these pages say now against what they said last cycle. Treat a change here as observed fact, and go and read the page if something moved.\n${describeChanges(
      args.changes
    )}`
  );

  if (args.previousHeadline) {
    parts.push(
      `The last brief opened with this. Do not spend this cycle re-establishing it; look for what has moved since.\n"${args.previousHeadline}"`
    );
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Pass 2: compose.
// ---------------------------------------------------------------------------

const COMPOSE_SYSTEM = `You are the competitive intelligence analyst for Velvex. You are given research notes and watchlist evidence, and you produce the brief.

${BUSINESS_CONTEXT}

The brief exists to answer one question: which position in this category is nobody holding, and could Velvex hold it credibly. Everything else in the document is there to support that answer or to say honestly that it could not be reached this cycle.

Rules that are not negotiable:

- Every finding carries an evidence standard: "observed" if it is on a page in the notes, "inferred" if you reasoned to it from something observed, "assumption" if you are filling a gap. This is the same standard Velvex applies to a client Ledger, and an intelligence brief that overclaims is off-standard in exactly the way the business says it never is. Tag honestly. An "assumption" is not a failure; a mislabelled inference is.
- Never name a company, a price or a claim that is not in the notes. If the notes did not establish something, it does not go in the brief.
- A positioning gap is a position, not a tactic. "Be the standard that gets used before a raise, not after a problem" is a position. "Post more on LinkedIn" is not. If you cannot say who vacated it and why nobody else can credibly claim it, it is not a gap yet.
- "What it would take" must be concrete enough to act on: a specific surface, a specific claim, a specific thing that would have to become true. Never "consider repositioning".
- Differentiation to reinforce means a thing Velvex already is, that somebody else is starting to claim or that the category is starting to treat as generic. Name the erosion, then name where to answer it.
- If a cycle genuinely found little, say so in the headline and leave the arrays short. A thin brief that says it is thin is useful. A padded one destroys the value of every brief after it.
- The owner's standing statement about Velvex outranks the open web. Never write a finding that contradicts it. If the research notes carry a stale claim about Velvex, say the public record is out of date, and treat correcting it as a differentiation item rather than a competitor finding.
- Ask exactly one question, or none. The open question is the single thing you could not establish from outside that the owner could settle in a few sentences, and that would actually change the next brief. Do not ask what the standing statement already answers, and do not ask a question you have asked before. If nothing this cycle clears that bar, set it to null. A question asked to fill the field teaches the owner to skip the field.

Caps, which the schema does not enforce: at most ${BRIEF_LIMITS.categoryLanguage} category language entries, ${BRIEF_LIMITS.competitorMoves} competitor moves, ${BRIEF_LIMITS.positioningGaps} positioning gaps, ${BRIEF_LIMITS.differentiationToReinforce} differentiation signals, ${BRIEF_LIMITS.watchNext} things to watch next. Fewer, better ones beat filling the quota.

Register: Velvex's own. Declarative, structural, specific. Short sentences. No filler, no hedging, no consultancy vocabulary, no "in today's market". Never use an em dash.

The title should name what this cycle found, not the date. "The audit word is being taken" is a title. "Weekly competitive intelligence brief" is not. The headline is one paragraph and it is the only thing some readers will read.`;

function composePrompt(args: {
  research: string;
  changes: SourceChange[];
  webResearch: boolean;
  truncated: boolean;
  consulted: string[];
  position: PositionStatement | null;
}): string {
  const parts: string[] = [];

  parts.push(positionContext(args.position));

  parts.push(`Research notes from this cycle:\n${args.research || "(the research pass returned nothing)"}`);

  parts.push(
    `Watchlist evidence, fetched directly. Anything here is observed fact.\n${describeChanges(
      args.changes
    )}`
  );

  parts.push(
    args.consulted.length
      ? `Pages actually retrieved this cycle. Cite from these; do not cite anything else.\n${args.consulted
          .map((url) => `- ${url}`)
          .join("\n")}`
      : "No pages were retrieved this cycle. Every claim must come from the watchlist evidence above, or be tagged as an assumption and named in limitations."
  );

  if (!args.webResearch) {
    parts.push(
      "Web research was switched off for this cycle. Work only from the watchlist evidence, and say plainly in limitations that the category was not searched."
    );
  }
  if (args.truncated) {
    parts.push(
      "The research pass hit its continuation limit and stopped early, so the notes above are partial. Say so in limitations."
    );
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Discovery: proposing what to watch, and the gate in front of it.
// ---------------------------------------------------------------------------

const DISCOVERY_SYSTEM = `You are the competitive intelligence researcher for Velvex. You have just finished a research pass. Two jobs now, and only these two.

${BUSINESS_CONTEXT}

FIRST. Decide whether this cycle found anything material. Be strict. Material means at least one of: a provider changed what they claim or how they bound their offer, a term in the category shifted meaning or ownership, a new entrant appeared, or a page on the watchlist moved its language. It does NOT mean you read some interesting pages. Most weeks in a small category are quiet, and saying so is the honest answer. If nothing moved, set anythingMaterial to false and write one plain sentence in quietNote saying what you checked and what was still the same. That sentence is the whole output for the week, so make it worth reading.

SECOND. Propose anything worth watching from now on, or nothing.

A candidate is a company or a page that could tell Velvex something week after week. Two kinds are worth proposing, and they are not the same:

- Something that might actually compete. Velvex returns a structural reading of commercial architecture, not a score. A tool that returns a number is not a competitor today, however similar the marketing sounds. Propose it as a competitor only if it reads a business structurally and delivers a judgement, not a rating.
- Something that is where a match would first appear. Category index pages, providers whose language is drifting toward structural vocabulary, and the places buyers and investors describe this problem in their own words. These are worth watching precisely because they do not match today. Language moves before product does.

Rules:

- Only propose a page you actually retrieved this cycle. A URL you did not open does not go in. If you cannot give the evidence, do not propose it.
- Evidence means what the page said, quoted or closely paraphrased. Not "appears to be a competitor".
- Tag the standard honestly. "observed" if you read it. "inferred" if you are reasoning from something you read. Never "observed" for a page you only saw in a search result.
- Propose at most three, and fewer is better. Each one costs the owner a decision, and a list of maybes trains them to stop reading the list.
- Do not propose Velvex, and do not propose anything already being watched. You will be told what is already watched.
- If nothing is worth watching, return an empty list. That is a normal week.

No em dashes. No filler.`;

/**
 * One candidate, as a decision for the owner.
 *
 * Every field they need to rule on it is in the payload, because approving is
 * what puts the page on the watchlist and there is no second chance to ask.
 */
function candidateAction(candidate: WatchCandidate): ProposedAction {
  return {
    type: "recommendation",
    summary: `Watch ${candidate.name}?`,
    channel: "internal",
    payload: {
      kind: "watch_candidate",
      name: candidate.name,
      url: candidate.url,
      suggestedKind: candidate.suggestedKind,
      whyItMightMatch: candidate.whyItMightMatch,
      evidence: candidate.evidence,
      standard: candidate.standard,
      cooldownDays: REJECTION_COOLDOWN_DAYS,
    },
    rationale:
      `${candidate.whyItMightMatch} Accept and it gets fetched and compared every week. ` +
      `Reject and it will not be proposed again for ${REJECTION_COOLDOWN_DAYS} days.`,
    dedupeKey: `intel:candidate:${candidateId(candidate.name)}`,
  };
}

/**
 * Fold the owner's rejections back into the ledger.
 *
 * Rejecting an approval does not run the agent, so a rejection would otherwise
 * leave no trace and the same candidate would be proposed again next week. The
 * agent reads its own rejected proposals at the start of a run and records the
 * verdict itself. Doing it here rather than adding a reject hook to the runner
 * keeps rejection free of side effects everywhere else in the system, which is
 * a property worth more than the small delay.
 */
async function absorbRejections(
  ledger: CandidateLedger,
  ctx: RunContext
): Promise<{ ledger: CandidateLedger; absorbed: number }> {
  const rejected = await ctx.db.listApprovals("rejected", 100).catch(() => []);
  let next = ledger;
  let absorbed = 0;

  for (const row of rejected) {
    if (row.agent_id !== "competitive_intel") continue;
    const payload = (row.action?.payload ?? {}) as Record<string, unknown>;
    if (payload["kind"] !== "watch_candidate") continue;

    const name = String(payload["name"] ?? "");
    const url = String(payload["url"] ?? "");
    if (!name || !url) continue;

    const existing = next[candidateId(name)];
    // Already recorded. Re-recording would restart the cooldown every week,
    // which would quietly turn a 180 day suppression into a permanent one.
    if (existing && existing.verdict === "rejected") continue;
    if (existing && existing.verdict === "accepted") continue;

    next = recordVerdict(
      next,
      { name, url, verdict: "rejected", note: row.decision_note ?? undefined },
      // Dated from the decision, not from now, so a rejection made two months
      // ago has two months less to run rather than starting over.
      row.decided_at ? new Date(row.decided_at) : ctx.now
    );
    absorbed += 1;
  }

  return { ledger: next, absorbed };
}

/**
 * Which candidates may be put to the owner this run.
 *
 * The shipped batch is drained first, because it was researched and verified by
 * hand and is better than anything a cold discovery pass will find in week one.
 * Discovery fills whatever is left of the allowance.
 */
function selectCandidates(
  discovered: WatchCandidate[],
  ledger: CandidateLedger,
  watched: readonly IntelSource[],
  now: Date
): WatchCandidate[] {
  const open = (list: WatchCandidate[]) =>
    list.filter((candidate) => candidateIsOpen(candidate, ledger, watched, now));

  const seed = open(SEED_CANDIDATES);
  const found = open(discovered).filter(
    (candidate) => !seed.some((entry) => candidateId(entry.name) === candidateId(candidate.name))
  );

  return [...seed, ...found].slice(0, MAX_CANDIDATES_PER_RUN);
}

// ---------------------------------------------------------------------------
// The other half of the loop: the owner answers, the agent reads the answer.
// ---------------------------------------------------------------------------

const ASSESS_SYSTEM = `You are the competitive intelligence analyst for Velvex. Last cycle you asked the owner one question, because it was the one thing you could not establish from outside. They have answered it.

${BUSINESS_CONTEXT}

Read their answer against the brief you wrote, and say what it changes. Three things, briefly:

1. What is now settled that was not. State it as fact, in one or two sentences, because it is now the record.
2. What that changes about the reading in the brief. If a gap you named is now clearly open, say so and say why the answer makes it open. If a gap is now closed off, say that instead, and be willing to say the brief was wrong.
3. One concrete thing worth doing about it, or nothing. "Nothing yet, and here is what would have to be true first" is a real answer and a better one than inventing a move.

Rules:

- The owner's answer is authoritative about Velvex. Do not argue with it, do not hedge it, do not ask them to prove it. Your job is to work out what it means, not to audit it.
- Do not restate the brief. They read it.
- If their answer means something you wrote was out of date or plainly wrong, say that in the first line. An intelligence function that cannot correct itself is worth nothing.
- Be direct. Nothing you say happens without their approval, so hedging costs you accuracy and buys nothing.
- No em dashes. No filler. Under 250 words.`;

/**
 * Assess one answered question.
 *
 * Deliberately a separate, cheap call rather than folded into the next weekly
 * brief. An answer given today that is not read until next Monday teaches the
 * owner that answering does not do anything, and the loop dies. This runs the
 * moment they answer.
 *
 * On the reasoning tier despite being short: it reads the owner's own words
 * about their business and decides what they mean for positioning. Getting
 * that wrong wastes the attention of the one person whose attention this whole
 * system exists to protect, and the call is a few thousand tokens at most.
 * Effort is medium, because the hard judgement was already done in the brief.
 */
export async function assessAnswer(
  args: { briefDate: string; question: string; answer: string; brief: IntelBrief | null },
  ctx: RunContext
): Promise<{ assessment: string; costUsd: number }> {
  const brief = args.brief;
  const summary = brief
    ? `The brief you wrote on ${brief.briefDate}, titled "${brief.title}":\n${brief.headline}\n\n` +
      `Positioning gaps you named:\n` +
      (brief.positioningGaps.map((gap) => `- ${gap.gap} (${gap.standard}): ${gap.whyOpen}`).join("\n") ||
        "- (none)") +
      `\n\nDifferentiation you flagged:\n` +
      (brief.differentiationToReinforce
        .map((item) => `- ${item.claim} (${item.standard}): ${item.pressure}`)
        .join("\n") || "- (none)") +
      `\n\nWhat you said you could not establish:\n${brief.limitations}`
    : "(the brief this question came from is no longer available)";

  const result = await ctx.claude.complete({
    system: ASSESS_SYSTEM,
    user:
      `${summary}\n\n` +
      `The question you asked:\n${args.question}\n\n` +
      `The owner's answer:\n${args.answer}`,
    model: MODEL,
    effort: "medium",
    maxTokens: 2000,
  });

  return { assessment: result.text, costUsd: result.costUsd };
}

// ---------------------------------------------------------------------------
// Picking the one thing that goes in front of the owner.
// ---------------------------------------------------------------------------

/**
 * A brief can carry four gaps and four reinforcement signals. All eight going
 * to the approvals queue every week would bury the queue, and a queue nobody
 * finishes reading is how a real failure sat unnoticed between six growth
 * ideas once already. So exactly one proposal leaves the brief: the single
 * highest-value move. The rest stay in the document, where they are read
 * deliberately rather than waved through.
 *
 * A gap outranks a reinforcement because occupying open ground is worth more
 * than defending held ground, and an observed finding outranks an inferred one.
 */
export function topMove(brief: ComposedBrief): {
  kind: "positioning_gap" | "differentiation";
  title: string;
  detail: Record<string, unknown>;
} | null {
  const rank = { observed: 0, inferred: 1, assumption: 2 } as const;

  const gap = [...brief.positioningGaps].sort(
    (a, b) => rank[a.standard] - rank[b.standard]
  )[0];
  if (gap) {
    return {
      kind: "positioning_gap",
      title: `Positioning gap: ${gap.gap}`,
      detail: { ...gap },
    };
  }

  const signal = [...brief.differentiationToReinforce].sort(
    (a, b) => rank[a.standard] - rank[b.standard]
  )[0];
  if (signal) {
    return {
      kind: "differentiation",
      title: `Reinforce differentiation: ${signal.claim}`,
      detail: { ...signal },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The agent.
// ---------------------------------------------------------------------------

export const competitiveIntelAgent: AgentDefinition = {
  id: "competitive_intel",
  name: "Competitive Intelligence",
  batch: "intelligence",
  description:
    "Watches adjacent diagnostics, business assessment and founder tooling, tracks how the language around business health, scale readiness and due diligence is moving, and writes a brief on which position Velvex could occupy. Advisory only: it files documents and makes a case, it never acts.",
  // The whole output is a judgement about where the business should stand in
  // its category, written once a week. Four calls a month is the cheapest place
  // in this system to buy real depth, and a wrong read here is expensive in a
  // way that is not obvious for months. See docs/MODEL-CHOICES.md.
  model: MODEL,
  // Measured, not guessed. At effort "max" the composing pass took 5m32s and
  // $0.64 on its own, which put a $1.25-capped run at $1.39 and left the weekly
  // cron no room for anything else. "high" is the same model reading the same
  // notes; what it buys back is a clock and a budget the rest of the system can
  // live inside. Raise it again only with a measurement, not a hunch.
  effort: "high",
  // Monthly, not weekly. The owner's read is that this category has few real
  // competitors and moves quarterly at most, so a weekly brief was paying full
  // price to say nothing changed. Overridable from the dashboard: set it back to
  // weekly and it lands on its own Monday tick.
  cadence: "monthly",
  observeOnly: true,
  approvedChannels: ["internal"],
  /**
   * The most one run may cost.
   *
   * Raised from $1.25 after a measured run stopped here having paid for the
   * research and produced nothing: research alone came to $1.1838, discovery
   * took it to $1.3132, and the composing pass was refused. Full price, no
   * brief, which is the worst outcome a ceiling can produce.
   *
   * $4.50 is deliberately well clear of a normal run rather than just above it.
   * Measured runs land at $1.31 to $1.39; at a monthly cadence the ceiling is
   * there to stop a runaway, not to shape an ordinary month. Note it bounds
   * when a request may START, so the true worst case is this plus the price of
   * one maximal call.
   */
  spendCapUsd: 4.5,

  routineRules: [
    {
      id: "competitive_intel.file_brief",
      describe: "Researching the category and filing a brief into its own library.",
      classification: "routine",
      test: (action) =>
        action.type === "intel_brief"
          ? "Writing a brief into its own library reaches nobody outside this system. It is the job."
          : null,
    },
    {
      id: "competitive_intel.report_movement",
      describe: "Reporting what moved on the watchlist.",
      classification: "routine",
      test: (action) =>
        action.type === "observation"
          ? "Noticing and logging that a watched source changed is monitoring, not acting."
          : null,
    },
  ],

  approvalRules: [
    {
      id: "competitive_intel.acts_on_nothing",
      describe:
        "Anything beyond writing a brief or reporting what moved. Occupying a position is a decision, and decisions are yours.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) =>
        action.type !== "intel_brief" && action.type !== "observation"
          ? `This agent researches and writes. "${action.type}" would have the business do something, and what Velvex claims about itself is your decision, not an agent's.`
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const day = ctx.now.toISOString().slice(0, 10);

    // The library is a fourth table, added in migration 0002. Checking for it
    // first turns "the migration has not been run" into a readable line on the
    // dashboard instead of a failed insert halfway through an expensive run.
    const ready = await ctx.db.intelReady();
    if (!ready.ok) {
      ctx.log(
        "competitive_intel: intel_briefs is missing, so there is nowhere to file a brief. " +
          "Apply db/migrations/0002_intelligence_layer.sql, then run this agent again. " +
          "Nothing was researched, so nothing was spent."
      );
      return [];
    }

    const watchlist =
      (await state.read<IntelWatchlist>(ctx.db, STATE_KEYS.intelWatchlist)) ??
      ({ updatedAt: ctx.now.toISOString(), sources: [] } as IntelWatchlist);
    const previousSnapshots =
      (await state.read<SourceSnapshotMap>(ctx.db, STATE_KEYS.intelSnapshots)) ?? {};

    // What the owner says is true of Velvex right now. Read before anything the
    // outside world says about it, and it wins where the two disagree.
    const position = await state
      .read<PositionStatement>(ctx.db, STATE_KEYS.intelPosition)
      .catch(() => null);

    // What the owner has already ruled on. Read before anything is proposed, so
    // a decision they have made is never put to them twice.
    const storedLedger =
      (await state.read<CandidateLedger>(ctx.db, STATE_KEYS.intelCandidates)) ?? {};
    const { ledger, absorbed } = await absorbRejections(storedLedger, ctx);
    if (absorbed > 0) {
      ctx.log(
        `competitive_intel: ${absorbed} rejection(s) recorded, suppressed for ` +
          `${REJECTION_COOLDOWN_DAYS} days from when you decided`
      );
      await state.write(
        ctx.db,
        STATE_KEYS.intelCandidates,
        ledger,
        `${Object.keys(ledger).length} watch candidate(s) ruled on`,
        { scope: "competitive_intel", agent: "competitive_intel", salience: 5, tags: ["intel"] }
      );
    }

    const webResearch = flag(ctx.env.INTEL_WEB_RESEARCH_ENABLED);

    // With no watchlist and no web access there is nothing to look at. Saying
    // so once a cycle is honest; running two Opus calls over an empty desk and
    // filing the result as a brief would not be.
    // With web research off and nothing on the watchlist there is nothing to
    // research and nothing to compare, so no model runs at all. What is left is
    // the candidates still waiting to be ruled on: those are put to the owner
    // directly, because deciding them is what unblocks the agent.
    if (watchlist.sources.length === 0 && !webResearch) {
      const pending = selectCandidates([], ledger, watchlist.sources, ctx.now);

      if (pending.length === 0) {
        ctx.log("competitive_intel: nothing watched, nothing pending, web research off");
        return [
          {
            type: "observation",
            summary: "Competitive Intelligence has nothing to look at yet",
            payload: {
              note:
                "Every shipped candidate has been ruled on and nothing is being watched. Set " +
                "INTEL_WEB_RESEARCH_ENABLED=\"true\" in wrangler.toml to let it look for new ones.",
              active: false,
            },
            rationale:
              "No sources, no pending candidates and no web access, so it has not run and has cost nothing.",
            dedupeKey: `intel:idle:${day}`,
          },
        ];
      }

      ctx.log(
        `competitive_intel: web research off and nothing watched, ` +
          `putting ${pending.length} candidate(s) to you. No model was called.`
      );
      return pending.map(candidateAction);
    }

    const { changes, snapshots } = await gatherWatchlist(watchlist, previousSnapshots, ctx);

    // Continuity. The last brief tells this one what it said it would check.
    const previousBriefs = await ctx.db.listIntelBriefs(1).catch(() => []);
    const previous = previousBriefs[0];
    const previousDocument = previous
      ? ((await ctx.db.getIntelBrief(previous.brief_date).catch(() => null))?.document as
          | IntelBrief
          | undefined)
      : undefined;
    // Bounded, and bounded for a measured reason. Carrying every open thread
    // forward took the research pass from $0.6601 to $1.1838 between two runs —
    // six carried questions, 79% more spend — and it grows every cycle, because
    // each brief adds more. Memory that only accumulates makes a run more
    // expensive every time it runs. Three is what fits in a prompt without
    // becoming the prompt.
    const carriedQuestions = (previousDocument?.watchNext ?? []).slice(0, MAX_CARRIED_QUESTIONS);

    // What the strategist has been weighing, so intelligence answers live
    // questions rather than arriving beside them. This is the loop the owner's
    // notes described: intelligence is worth having once strategy has something
    // to ask it.
    const strategyReports = await ctx.db
      .listReports({ agentId: "growth_strategy", limit: 4 })
      .catch(() => []);
    const liveStrategyQuestions = strategyReports.map((row) => row.summary).filter(Boolean);

    // --- pass 0: the scan -------------------------------------------------
    //
    // Cheap, and first. It decides whether the expensive pass runs at all. The
    // old order asked "was this cycle worth a brief" only after the research
    // pass had been paid for, which meant a quiet cycle still cost a dollar.
    const settled = (await state.read<string[]>(ctx.db, STATE_KEYS.intelSettled)) ?? [];
    const movedCount = changes.filter((change) => change.state === "changed").length;
    const seedPending = selectCandidates([], ledger, watchlist.sources, ctx.now);

    let leads: string[] = [];
    if (webResearch) {
      const scan = await ctx.claude.complete<ScanResult>({
        system: SCAN_SYSTEM,
        user: scanPrompt({
          previousBriefDate: previous?.brief_date ?? null,
          previousHeadline: previousDocument?.headline ?? previous?.headline ?? null,
          carriedQuestions,
          settled,
          changes,
          position,
          recheck: recheckUrls(watchlist.sources, previousDocument?.sources),
        }),
        // The balanced model, not the reasoning one. This pass matches what it
        // reads against what it was told is settled; it does not judge what any
        // of it means. Paying reasoning prices for that is how the cheap pass
        // stops being cheap.
        model: MODELS.balanced,
        effort: "low",
        maxTokens: 8000,
        schema: SCAN_SCHEMA,
        // Four fetches, not two. The first scan could verify one provider of
        // five, which is not enough for "nothing moved" to mean anything. On
        // the balanced model four pages at 6000 tokens is a few cents, against
        // a research pass that costs a dollar.
        web: { maxSearches: 3, maxFetches: 4, maxContentTokens: 6000 },
      });

      const verdict = scan.parsed;
      leads = verdict?.leads ?? [];

      if (verdict?.settledNow?.length) {
        await state.write(
          ctx.db,
          STATE_KEYS.intelSettled,
          mergeSettled(settled, verdict.settledNow),
          `${verdict.settledNow.length} finding(s) settled this cycle`,
          { scope: "competitive_intel", agent: "competitive_intel", salience: 3, tags: ["intel"] }
        );
      }

      ctx.log(
        `competitive_intel: scan says ${verdict?.somethingMoved ? "something moved" : "nothing moved"}, ` +
          `${leads.length} lead(s), ${verdict?.settledNow?.length ?? 0} settled ` +
          `($${scan.costUsd.toFixed(4)})`
      );

      // The cheap month. Nothing moved, nothing on the watchlist shifted, and
      // the only thing outstanding is candidates to rule on — which came from a
      // compiled list and cost nothing to produce. Hand those over and stop.
      if (verdict && !verdict.somethingMoved && movedCount === 0) {
        const kept = seedPending.map(candidateAction);
        // The note is what the owner actually reads on a quiet cycle, so it has
        // to say something even when the model returns the field empty.
        const why = verdict.why?.trim() || "Nothing in the category moved this cycle.";
        ctx.log(
          `competitive_intel: quiet cycle, no research. ${why} ` +
            `(${kept.length} candidate(s), $${scan.costUsd.toFixed(4)})`
        );
        return [
          ...kept,
          {
            type: "observation",
            summary: `Quiet cycle: ${why}`,
            payload: {
              quiet: true,
              scannedOnly: true,
              costUsd: scan.costUsd,
              settledCount: mergeSettled(settled, verdict.settledNow ?? []).length,
            },
            rationale:
              "The scan found nothing that would change the last brief, so the research and " +
              "composing passes were not run. A brief every cycle regardless of what happened " +
              "is how a library stops being read, and it is paid for either way.",
            dedupeKey: `intel:quiet:${day}`,
          },
        ];
      }
    }

    ctx.log(
      `competitive_intel: researching (web ${webResearch ? "on" : "off"}, ` +
        `${carriedQuestions.length} carried question(s), ${leads.length} lead(s), ` +
        `${position ? `${position.answers.length} answered` : "no position statement"})`
    );

    // --- pass 1: research -------------------------------------------------
    const research = await ctx.claude.complete({
      system: RESEARCH_SYSTEM,
      user: researchPrompt({
        changes,
        carriedQuestions,
        previousHeadline: previousDocument?.headline ?? previous?.headline ?? null,
        liveStrategyQuestions,
        position,
      }),
      model: MODEL,
      // High rather than max: this pass is gathering, and depth here buys less
      // than depth in the pass that decides what any of it means.
      effort: "high",
      // Thinking is billed inside max_tokens on this model, so a budget sized
      // for the answer alone gets consumed before the answer starts. This is
      // sized for both.
      maxTokens: 32000,
      ...(webResearch
        ? { web: { maxSearches: MAX_SEARCHES, maxFetches: MAX_FETCHES } }
        : {}),
    });

    ctx.log(
      `competitive_intel: research done, ${research.searchesUsed} search(es), ` +
        `${research.sources.length} page(s) read, $${research.costUsd.toFixed(4)}` +
        (research.truncated ? ", stopped at the continuation limit" : "")
    );

    // --- pass 2: discovery and triage ------------------------------------
    //
    // Cheap, schema'd, no tools. It does two things the expensive pass should
    // not be paid to do: decide whether the week was material at all, and
    // propose what is worth watching from now on. Putting the triage here is
    // what makes a quiet week cost one pass instead of two.
    const watchedList = watchlist.sources
      .map((source) => `- ${source.label} (${source.kind}) ${source.url}`)
      .join("\n");

    const discovery = await ctx.claude.complete<DiscoveryResult>({
      system: DISCOVERY_SYSTEM,
      user:
        `${positionContext(position)}\n\n` +
        `Your research notes from this cycle:\n${research.text || "(nothing returned)"}\n\n` +
        `Watchlist evidence, fetched directly:\n${describeChanges(changes)}\n\n` +
        `Already watched, do not propose these again:\n${watchedList || "(nothing watched yet)"}\n\n` +
        `Pages you actually retrieved this cycle:\n${
          research.sources.map((source) => `- ${source.url}`).join("\n") || "(none)"
        }`,
      model: MODEL,
      effort: "medium",
      maxTokens: 4000,
      schema: DISCOVERY_SCHEMA,
    });

    const found = discovery.parsed?.candidates ?? [];
    const proposals = selectCandidates(found, ledger, watchlist.sources, ctx.now);
    // movedCount is computed once, before the scan, and reused here.

    ctx.log(
      `competitive_intel: discovery found ${found.length} candidate(s), ` +
        `${proposals.length} to put to you, material=${discovery.parsed?.anythingMaterial ?? false}`
    );

    const candidateActions: ProposedAction[] = proposals.map(candidateAction);

    // --- the quiet week ---------------------------------------------------
    //
    // Nothing moved on the watchlist, nothing new to rule on, and the triage
    // says the category did not shift. There is no brief to write. Writing one
    // anyway would cost the expensive pass and, worse, would teach the owner
    // that a brief in the library does not mean anything happened.
    if (!discovery.parsed?.anythingMaterial && movedCount === 0 && proposals.length === 0) {
      const note = discovery.parsed?.quietNote?.trim() || "Nothing in the category moved this cycle.";
      const spent = research.costUsd + discovery.costUsd;

      await state.write(
        ctx.db,
        STATE_KEYS.intelSnapshots,
        snapshots,
        `${Object.keys(snapshots).length} watched sources snapshotted`,
        { scope: "competitive_intel", agent: "competitive_intel", salience: 3, tags: ["intel"] }
      );

      ctx.log(`competitive_intel: quiet week, no brief. ${note} ($${spent.toFixed(4)})`);
      return [
        {
          type: "observation",
          summary: `Quiet week: ${note}`,
          payload: {
            quiet: true,
            sourcesWatched: changes.length,
            searchesUsed: research.searchesUsed,
            costUsd: Math.round(spent * 1_000_000) / 1_000_000,
          },
          rationale:
            "The category did not move and nothing new is worth watching, so no brief was " +
            "composed. A brief every week regardless of what happened is how briefs stop being read.",
          dedupeKey: `intel:quiet:${day}`,
        },
      ];
    }

    // --- pass 3: compose --------------------------------------------------
    // The composing pass is the one that can be refused for budget, and when it
    // is, everything cheap that came before it must not go down with it.
    //
    // That is not hypothetical. A measured run spent $1.3132 on research and
    // discovery, was refused the composing pass by the ceiling, threw, and lost
    // the four candidates discovery had already worked out. Full price, nothing
    // delivered, and the candidates were not even part of the brief: they are a
    // list of sources to rule on, and ruling on them is what unblocks the agent.
    let composed: Awaited<ReturnType<typeof ctx.claude.complete<ComposedBrief>>>;
    try {
      composed = await ctx.claude.complete<ComposedBrief>({
        system: COMPOSE_SYSTEM,
        user: composePrompt({
          research: research.text,
          changes,
          webResearch,
          truncated: research.truncated,
          consulted: research.sources.map((source) => source.url),
          position,
        }),
        model: MODEL,
        effort: competitiveIntelAgent.effort,
        // Thinking comes out of the same budget as the JSON on this model. Too
        // small a number here does not shorten the brief, it truncates it
        // mid-object and the parse fails after the tokens are already paid for.
        maxTokens: 32000,
        schema: BRIEF_SCHEMA,
      });
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      ctx.log(
        `competitive_intel: no brief, the ceiling stopped the composing pass ` +
          `($${err.spentUsd.toFixed(4)} of $${err.capUsd.toFixed(2)}). ` +
          `Keeping ${candidateActions.length} candidate(s).`
      );
      return [
        ...candidateActions,
        {
          type: "observation",
          summary: "The composing pass was stopped by the spend ceiling, so there is no brief",
          payload: {
            spentUsd: err.spentUsd,
            capUsd: err.capUsd,
            researchUsd: research.costUsd,
            candidatesKept: candidateActions.length,
            note:
              "Research and discovery completed and were paid for. The brief was not written. " +
              "The candidates below came out of the cheap half and are still worth ruling on.",
          },
          rationale:
            "A run that is stopped for budget after the expensive half should still hand over " +
            "the cheap half, rather than paying full price and delivering nothing.",
          dedupeKey: `intel:capped:${day}`,
        },
      ];
    }

    if (!composed.parsed) {
      throw new Error("The composing pass returned no brief matching the schema.");
    }

    const brief: IntelBrief = {
      ...clampBrief(composed.parsed),
      briefDate: day,
      meta: {
        generatedAt: ctx.now.toISOString(),
        sourcesChanged: changes.filter((change) => change.state === "changed").length,
        sourcesWatched: changes.length,
        webResearch,
        searchesUsed: research.searchesUsed,
        model: MODEL,
        costUsd: Math.round((research.costUsd + composed.costUsd) * 1_000_000) / 1_000_000,
      },
    };

    // Snapshots are written only now, once the run has produced a brief. A run
    // that failed earlier leaves last week's snapshots in place, so the change
    // it never got to read is still there to be read next time.
    await state.write(
      ctx.db,
      STATE_KEYS.intelSnapshots,
      snapshots,
      `${Object.keys(snapshots).length} watched sources snapshotted`,
      { scope: "competitive_intel", agent: "competitive_intel", salience: 3, tags: ["intel"] }
    );

    ctx.log(
      `competitive_intel: brief composed, ${brief.positioningGaps.length} gap(s), ` +
        `${brief.competitorMoves.length} move(s), ` +
        `${brief.openQuestion ? "one question for you" : "nothing to ask"}, ` +
        `$${brief.meta.costUsd.toFixed(4)} total`
    );

    const actions: ProposedAction[] = [
      {
        type: "intel_brief",
        summary: brief.title,
        payload: {
          brief: brief as unknown as Record<string, unknown>,
          substantive: briefIsSubstantive(brief),
        },
        rationale:
          `Researched ${brief.meta.sourcesWatched} watched source(s) and ` +
          `${brief.meta.searchesUsed} search(es), and filed the result as a brief.`,
        dedupeKey: `intel:brief:${day}`,
      },
    ];

    const moved = changes.filter((change) => change.state === "changed");
    if (moved.length > 0) {
      actions.push({
        type: "observation",
        summary: `${moved.length} watched source${moved.length === 1 ? "" : "s"} changed language this cycle`,
        payload: {
          changed: moved.map((change) => ({
            label: change.label,
            url: change.url,
            kind: change.kind,
            added: change.added,
            removed: change.removed,
          })),
        },
        rationale: "Recorded against the pages themselves, not the model's recollection of them.",
        dedupeKey: `intel:moved:${day}`,
      });
    }

    // Candidates to rule on. Each is its own decision, capped per run.
    actions.push(...candidateActions);

    // One move, and only one, goes in front of the owner.
    const move = topMove(brief);
    if (move) {
      actions.push({
        type: "recommendation",
        summary: move.title,
        payload: {
          kind: move.kind,
          ...move.detail,
          briefDate: day,
          briefTitle: brief.title,
          // Occupying a position changes what Velvex claims about itself, which
          // the general boundary treats as a messaging change on top of this
          // agent's own rule. Both should fire; it is that kind of decision.
          changesPositioning: true,
        },
        rationale:
          `The strongest single move in the ${day} brief. The rest of the brief stays in the ` +
          `library rather than in this queue.`,
        dedupeKey: `intel:move:${day}`,
      });
    }

    return actions;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type === "intel_brief") {
      const brief = action.payload["brief"] as IntelBrief | undefined;
      if (!brief) {
        return { outcome: "failed", error: "No brief on the action to file." };
      }

      const row = await ctx.db.upsertIntelBrief({
        brief_date: brief.briefDate,
        title: brief.title,
        headline: brief.headline,
        document: brief as unknown as Record<string, unknown>,
        gap_count: brief.positioningGaps.length,
        move_count: brief.competitorMoves.length,
        source_count: brief.sources.length,
        sources_watched: brief.meta.sourcesWatched,
        sources_changed: brief.meta.sourcesChanged,
        web_research: brief.meta.webResearch,
        searches_used: brief.meta.searchesUsed,
        model: brief.meta.model,
        cost_usd: brief.meta.costUsd,
        run_id: ctx.runId,
      });

      // A pointer, not the document. Memory is read into other agents' prompts,
      // so what goes here is one line telling them a brief exists and where.
      await state.write(
        ctx.db,
        STATE_KEYS.intelLatest,
        {
          briefDate: brief.briefDate,
          id: row.id ?? null,
          title: brief.title,
          headline: brief.headline,
          gaps: brief.positioningGaps.map((gap) => gap.gap),
        },
        `Latest competitive intelligence brief (${brief.briefDate}): ${brief.title}`,
        { scope: "competitive_intel", agent: "competitive_intel", salience: 7, tags: ["intel"] }
      );

      return {
        outcome: "executed",
        externalRef: row.id ?? brief.briefDate,
        detail: {
          briefDate: brief.briefDate,
          title: brief.title,
          headline: brief.headline,
          gaps: brief.positioningGaps.length,
          costUsd: brief.meta.costUsd,
        },
      };
    }

    // Accepting a candidate is the one thing an approval here actually changes.
    // It adds a page to what gets fetched and compared every week, which is why
    // it is a decision rather than something the agent does for itself.
    if (action.type === "recommendation" && action.payload["kind"] === "watch_candidate") {
      const name = String(action.payload["name"] ?? "");
      const url = String(action.payload["url"] ?? "");
      const kind = String(action.payload["suggestedKind"] ?? "category") as IntelSource["kind"];
      if (!name || !url) {
        return { outcome: "failed", error: "The candidate carried no name or URL." };
      }

      const watchlist =
        (await state.read<IntelWatchlist>(ctx.db, STATE_KEYS.intelWatchlist)) ??
        ({ updatedAt: ctx.now.toISOString(), sources: [] } as IntelWatchlist);

      const id = candidateId(name);
      // Idempotent: approving twice must not create a second entry, which would
      // share one snapshot key and make each report the other as a rewrite.
      const already = watchlist.sources.some(
        (source) => source.id === id || normaliseUrl(source.url) === normaliseUrl(url)
      );
      const sources = already
        ? watchlist.sources
        : [
            ...watchlist.sources,
            {
              id,
              label: name,
              url,
              kind,
              ...(action.payload["whyItMightMatch"]
                ? { note: String(action.payload["whyItMightMatch"]) }
                : {}),
            },
          ];

      await state.write(
        ctx.db,
        STATE_KEYS.intelWatchlist,
        { updatedAt: ctx.now.toISOString(), sources },
        `${sources.length} sources on the competitive intelligence watchlist`,
        { scope: "competitive_intel", agent: "competitive_intel", salience: 7, tags: ["intel"] }
      );

      const ledger = (await state.read<CandidateLedger>(ctx.db, STATE_KEYS.intelCandidates)) ?? {};
      await state.write(
        ctx.db,
        STATE_KEYS.intelCandidates,
        recordVerdict(ledger, { name, url, verdict: "accepted" }, ctx.now),
        `${Object.keys(ledger).length + 1} watch candidate(s) ruled on`,
        { scope: "competitive_intel", agent: "competitive_intel", salience: 5, tags: ["intel"] }
      );

      return {
        outcome: "executed",
        externalRef: id,
        detail: {
          watching: name,
          url,
          kind,
          note: already
            ? "Already on the watchlist; the verdict was recorded and nothing was duplicated."
            : "Added to the watchlist. It will be fetched and compared against itself every run.",
          watchlistSize: sources.length,
        },
      };
    }

    // Only reached after the owner approves it. Even then, all it does is
    // record the direction: putting a position into public copy is work for the
    // agents that own those surfaces, under their own rules.
    if (action.type === "recommendation") {
      // The kind is part of the key. A brief's top move and an assessment of an
      // answered question are both recommendations and can both be approved on
      // the same day; memory keys are unique, so a date alone would let the
      // second silently overwrite the first.
      const kind = String(action.payload["kind"] ?? "direction").replace(/[^a-z0-9_]/gi, "_");
      await ctx.db.writeMemory({
        key: `positioning.${ctx.now.toISOString().slice(0, 10)}.${kind}`,
        scope: "global",
        kind: "decision",
        content: `Approved positioning direction: ${action.summary}`,
        detail: action.payload,
        // High on purpose. This is read into the writing agents' context, which
        // is the only way an approved position reaches anything public.
        salience: 9,
        source_agent: "competitive_intel",
        tags: ["intel", "positioning", "strategy"],
      });

      return {
        outcome: "executed",
        detail: {
          note:
            "Recorded as an approved positioning direction. Carrying it into public copy stays " +
            "with the agents that own those channels, under their own rules.",
        },
      };
    }

    return { outcome: "observed", detail: action.payload };
  },
};
