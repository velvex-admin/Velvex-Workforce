// What an agent has learned from what happened to the things it proposed.
//
// Three layers, and only two of them have anything true in them today.
//
//   episodic   what happened. This already exists — it is the `reports` table,
//              one row per action with its outcome. What was missing is a way
//              to look at it as EVIDENCE rather than as history: a proposal
//              joined to what the owner decided about it. That join is what
//              `episodes` below holds, and it is a bounded ring, not a log.
//   semantic   what is true about the world we act on. For a channel that
//              means audience truth, and the audience is not answering: X's
//              free tier posts but does not read, so `fetchMetrics()` returns
//              402 and no post has ever reported an impression. This layer is
//              therefore DELIBERATELY EMPTY, and the prompt says so in words
//              rather than letting the model infer a pattern from post text.
//              It fills in the day read access is bought; nothing else changes.
//   procedural what works. Formed from resolved episodes, fed back into the
//              next drafting call.
//
// The thing this file is most careful about is not learning. It is forgetting.
//
// An additive memory costs more every cycle and grows more confident while it
// does it. That is not a hypothetical here: carrying every open question
// forward took the intelligence agent's research pass from $0.66 to $1.18 in
// one cycle, and the fix was `intel.settled` plus a hard cap on what is carried.
// The same discipline applies to a lesson. Every one carries a support count, a
// contradiction count and a last-confirmed date, and `demote()` drops the ones
// the evidence has stopped backing. A set that only ever grows is the failure
// mode, not the goal.

/**
 * The salience at or above which a memory row is read into OTHER agents'
 * prompts.
 *
 * Two callers read memory with no tag filter and no scope: Growth-Strategy
 * (`growth-strategy.ts`, minSalience 6, limit 30) and Chief-of-Staff
 * (`chief-of-staff.ts`, minSalience 6, limit 25). Anything written at or above
 * this number lands in both of their prompts on every run, whether or not they
 * asked for it.
 *
 * That is the mistake the intelligence layer already caught and designed around:
 * a full brief in `memory` would have been read, and paid for, by every agent on
 * every tick, so only a one-line pointer goes there and the document lives in
 * its own table. A per-agent learning record broadcast the same way would be the
 * same mistake with more rows.
 *
 * So lessons are written BELOW this floor and retrieved by explicit tag query.
 * That is a fact about the PostgREST filter, not a convention anyone has to
 * remember — and `test/learning-retrieval.test.ts` asserts both halves: that we
 * write below the floor, and that the two broadcast readers still read at it.
 */
export const BROADCAST_FLOOR = 6;

/** Where a learning record is written. Below the floor, so it stays private. */
export const LESSON_SALIENCE = 4;

/** The memory key holding one agent's whole learning record. */
export function learningKey(agentId: string): string {
  return `learning.${agentId}`;
}

/**
 * One row, not a row per lesson.
 *
 * A row per lesson would cost a subrequest per lesson to read and would grow
 * the key space without bound. A Worker invocation has roughly fifty
 * subrequests for everything it runs, shared across every agent on the tick,
 * and this repo has already lost a run's output to exhausting them. One read
 * and one write is the whole budget this layer is allowed.
 */
export interface LearningRecord {
  updatedAt: string;
  episodes: Episode[];
  lessons: Lesson[];
  /** Verdicts absorbed since lessons were last formed. Gates the model call. */
  pendingVerdicts: number;
  lastFormedAt?: string;
}

/**
 * A thing the agent did, and what became of it.
 *
 * `key` is the proposal's dedupe key, which is how a verdict arriving days
 * later is joined back to the proposal that earned it. It is the only stable
 * handle: the approval row carries it, and it already encodes the content hash
 * so two differently-worded ideas are two episodes rather than one.
 */
export interface Episode {
  at: string;
  key: string;
  kind: "growth_idea" | "draft";
  summary: string;
  /**
   * The comparable parts. Deliberately a flat string map: these are what a
   * lesson generalises over, and a nested shape would invite storing the whole
   * proposal here, which is what `reports` is already for.
   */
  features: Record<string, string>;
  /** The owner's ruling, once there is one. Absent means still pending. */
  verdict?: "approved" | "rejected";
  verdictAt?: string;
}

/**
 * Something the agent believes about its own work, with the evidence for it.
 *
 * `support` and `contradict` are counts of resolved episodes consistent and
 * inconsistent with the claim. A lesson is never a bare assertion: it carries
 * what it was formed from, because a claim whose basis nobody can check is
 * exactly the confident-rule-with-nothing-validating-it failure this whole
 * design exists to avoid.
 */
export interface Lesson {
  id: string;
  claim: string;
  basis: string;
  support: number;
  contradict: number;
  firstSeen: string;
  lastConfirmed: string;
}

/** Keeps the ring small enough that reading it is never the expensive part. */
export const MAX_EPISODES = 40;
/** More than this is not a set of lessons, it is a second prompt. */
export const MAX_LESSONS = 10;
/** How many lessons reach the drafting prompt. The rest stay on file. */
export const PROMPT_LESSONS = 5;
/** Verdicts that must accumulate before paying for a formation call. */
export const FORM_AFTER_VERDICTS = 5;
/**
 * A lesson nothing has confirmed for this long is stale rather than wrong.
 *
 * Dropping it is the cheaper error: a true claim will be re-derived from the
 * next batch of episodes at no extra cost, whereas a false one that nothing
 * contradicts simply because the agent stopped proposing that kind of thing
 * would sit in the prompt forever, shaping drafts on evidence that has aged out.
 */
export const LESSON_STALE_DAYS = 45;

export function emptyRecord(now: Date): LearningRecord {
  return { updatedAt: now.toISOString(), episodes: [], lessons: [], pendingVerdicts: 0 };
}

/**
 * Normalised identity for a claim.
 *
 * Lifted wholesale from `settledKey()` in the intelligence layer, and for the
 * reason that one exists: a model rephrases the same finding every cycle. The
 * settled list stored one fact twice as "credited toward delivery" and
 * "credited toward the delivery engagement" because it matched on the whole
 * string. Comparing a normalised prefix is what stops one belief occupying
 * several slots and drowning out the others.
 */
export function lessonId(claim: string): string {
  return claim.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48);
}

/** Append episodes, newest last, bounded. */
export function recordEpisodes(
  record: LearningRecord,
  incoming: Episode[],
  now: Date
): LearningRecord {
  const known = new Set(record.episodes.map((episode) => episode.key));
  const fresh = incoming.filter((episode) => !known.has(episode.key));
  const episodes = [...record.episodes, ...fresh].slice(-MAX_EPISODES);
  return { ...record, episodes, updatedAt: now.toISOString() };
}

/**
 * Add resolved episodes for rulings this record has never seen.
 *
 * `applyVerdicts` joins a ruling onto an episode the agent recorded when it
 * made the proposal, which means it can only ever see rulings made SINCE the
 * learning layer shipped. Everything the owner decided before that is invisible
 * to it — and on X that was nine real rulings, eight approvals and a rejection,
 * sitting in `pending_approvals` with the whole original action still attached.
 * Starting from zero when that evidence is already on file would have made the
 * agent wait weeks to learn something it could have known on its first run.
 *
 * Twice over, in fact: those keys predate the content hash `dedupeKey` now
 * appends, so even a re-proposal of the identical idea would not have matched.
 *
 * This is not a weaker kind of episode. The stored row carries the proposal's
 * title, its risk and its type, so the reconstruction has the same fields the
 * live path records — which is also why nothing marks a back-filled episode as
 * such in `features`: the model generalises over features, and a flag that
 * happens to correlate with "approved" across a historical batch is exactly the
 * spurious rule this layer is supposed to avoid. The `at` timestamp already
 * says when it happened.
 *
 * Only ruled episodes are back-filled. A still-pending historical proposal is
 * left alone: the agent will record it itself if it proposes it again, and
 * inventing an unresolved episode for it would just age out unanswered.
 */
export function backfillEpisodes(
  record: LearningRecord,
  incoming: Episode[],
  now: Date
): { record: LearningRecord; added: number } {
  const known = new Set(record.episodes.map((episode) => episode.key));
  const fresh = incoming.filter((episode) => episode.verdict && !known.has(episode.key));
  if (fresh.length === 0) return { record, added: 0 };

  return {
    record: {
      ...record,
      episodes: [...record.episodes, ...fresh].slice(-MAX_EPISODES),
      pendingVerdicts: record.pendingVerdicts + fresh.length,
      updatedAt: now.toISOString(),
    },
    added: fresh.length,
  };
}

/**
 * The verdict a stored approval represents, or null while it is still open.
 *
 * `executed` counts as approved because it is what an approved action becomes
 * once it runs — the owner's ruling is the same one either way. `failed` does
 * NOT count as rejected: the owner said yes and the machinery broke, which is
 * a fact about the connector, not about the judgement. Treating it as a
 * rejection would teach the agent to stop proposing things that were approved.
 */
export function verdictOf(status: string | undefined): Episode["verdict"] | null {
  if (status === "approved" || status === "executed") return "approved";
  if (status === "rejected") return "rejected";
  return null;
}

/**
 * Join stored rulings onto the episodes that earned them. No model, no cost.
 *
 * This is `absorbRejections()` from the intelligence agent generalised: a
 * rejection has no side effects anywhere else in this system, so an agent that
 * wants to learn from one has to go and read it. The difference is that this
 * reads approvals too — a rejection alone says what not to do and nothing about
 * what to do instead.
 */
export function applyVerdicts(
  record: LearningRecord,
  rulings: Array<{ key: string; status?: string; decidedAt?: string }>,
  now: Date
): { record: LearningRecord; resolved: number } {
  const byKey = new Map(rulings.map((ruling) => [ruling.key, ruling]));
  let resolved = 0;

  const episodes = record.episodes.map((episode) => {
    if (episode.verdict) return episode;
    const ruling = byKey.get(episode.key);
    if (!ruling) return episode;
    const verdict = verdictOf(ruling.status);
    if (!verdict) return episode;
    resolved += 1;
    return { ...episode, verdict, verdictAt: ruling.decidedAt ?? now.toISOString() };
  });

  return {
    record: {
      ...record,
      episodes,
      pendingVerdicts: record.pendingVerdicts + resolved,
      updatedAt: now.toISOString(),
    },
    resolved,
  };
}

/** Episodes the owner has actually ruled on. The only evidence worth forming on. */
export function resolvedEpisodes(record: LearningRecord): Episode[] {
  return record.episodes.filter((episode) => episode.verdict);
}

/** Enough new evidence to be worth a model call, and not before. */
export function shouldForm(record: LearningRecord): boolean {
  return record.pendingVerdicts >= FORM_AFTER_VERDICTS;
}

/** How much a lesson is believed. Zero evidence is zero confidence, not one. */
export function confidence(lesson: Lesson): number {
  const total = lesson.support + lesson.contradict;
  return total === 0 ? 0 : lesson.support / total;
}

/**
 * Fold newly formed claims into the set, keeping the history of ones already
 * held. A re-derived claim gains support and a new last-confirmed date rather
 * than replacing itself, which is what makes a long-standing lesson outrank a
 * freshly invented one.
 */
export function mergeLessons(
  record: LearningRecord,
  incoming: Array<{ claim: string; basis: string; support: number; contradict: number }>,
  now: Date
): LearningRecord {
  const at = now.toISOString();
  const byId = new Map(record.lessons.map((lesson) => [lesson.id, { ...lesson }]));

  for (const candidate of incoming) {
    const id = lessonId(candidate.claim);
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      existing.support += candidate.support;
      existing.contradict += candidate.contradict;
      existing.basis = candidate.basis;
      existing.lastConfirmed = at;
    } else {
      byId.set(id, {
        id,
        claim: candidate.claim,
        basis: candidate.basis,
        support: candidate.support,
        contradict: candidate.contradict,
        firstSeen: at,
        lastConfirmed: at,
      });
    }
  }

  return {
    ...record,
    lessons: [...byId.values()],
    pendingVerdicts: 0,
    lastFormedAt: at,
    updatedAt: at,
  };
}

/**
 * Drop what the evidence has stopped supporting, then keep the strongest.
 *
 * Two ways out. A lesson contradicted at least as often as it is supported is
 * not a lesson, it is a coin flip being quoted as guidance. A lesson nothing
 * has confirmed in LESSON_STALE_DAYS has aged out of the evidence that made it.
 * Whatever survives is capped, so the set has a ceiling as well as a floor.
 */
export function demote(record: LearningRecord, now: Date): LearningRecord {
  const cutoff = now.getTime() - LESSON_STALE_DAYS * 86_400_000;

  const kept = record.lessons
    .filter((lesson) => lesson.support > lesson.contradict)
    .filter((lesson) => Date.parse(lesson.lastConfirmed) >= cutoff)
    .sort((a, b) => {
      const byConfidence = confidence(b) - confidence(a);
      if (byConfidence !== 0) return byConfidence;
      return b.support - a.support;
    })
    .slice(0, MAX_LESSONS);

  return { ...record, lessons: kept, updatedAt: now.toISOString() };
}

/** The lessons that go into a prompt, strongest first. */
export function promptLessons(record: LearningRecord, limit = PROMPT_LESSONS): Lesson[] {
  return [...record.lessons]
    .sort((a, b) => {
      const byConfidence = confidence(b) - confidence(a);
      if (byConfidence !== 0) return byConfidence;
      return b.support - a.support;
    })
    .slice(0, limit);
}

/**
 * The procedural block for a drafting prompt, and the honest statement of what
 * is NOT in it.
 *
 * The second half matters as much as the first. With no engagement data, a
 * model handed a list of past posts and asked what worked will find a pattern,
 * because that is what it is for — and the pattern will be about nothing. Saying
 * plainly that no audience response exists is what stops a confident rule
 * forming on an absence. When metrics do arrive, this paragraph is what changes.
 */
export function learningContext(record: LearningRecord, hasAudienceData: boolean): string {
  const lessons = promptLessons(record);
  const lines = lessons.length
    ? lessons
        .map(
          (lesson) =>
            `- ${lesson.claim} (held since ${lesson.firstSeen.slice(0, 10)}; ` +
            `${lesson.support} for, ${lesson.contradict} against)`
        )
        .join("\n")
    : "(nothing established yet — not enough rulings have come back)";

  const audience = hasAudienceData
    ? ""
    : "\n\nYou have NO audience-response data for this channel. Nothing here tells you " +
      "which posts were read, liked or ignored, because the platform does not report it " +
      "back to us. Do not infer what landed from the text of past posts: you would be " +
      "reading a pattern in your own writing, not in anyone's response to it. What you " +
      "can learn from is above — what the owner approved and what they turned down.";

  return `What you have learned about what gets approved here:\n${lines}${audience}`;
}
