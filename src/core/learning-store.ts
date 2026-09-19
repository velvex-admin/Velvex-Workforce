// Reading, writing and forming an agent's learning record.
//
// Split from `learning.ts` on purpose: everything there is pure and can be
// driven by a test with no database and no model. Everything that costs a
// subrequest or a token is here, where the cost is easy to count.
//
// The cost budget for this whole layer, per run that uses it:
//
//   1 read   the learning record
//   1 read   this agent's rulings
//   1 write  the record back
//   0 or 1   model call, only when FORM_AFTER_VERDICTS rulings have piled up
//
// Three subrequests is not free. A Worker invocation gets roughly fifty for
// everything on the tick, shared across every agent that runs, and site
// integrity already dies at the end of the hourly tick from exactly that. So
// the caller is expected to do this work ONLY on runs that were going to make a
// model call anyway — which is also precisely when the lessons get used. A run
// that skips drafting because the shelf is full should skip learning too.

import type { Supabase } from "../lib/supabase.js";
import type { Claude } from "../lib/claude.js";
import { MODELS, SHORT_ANSWER_MAX_TOKENS } from "./models.js";
import {
  applyVerdicts,
  backfillEpisodes,
  demote,
  emptyRecord,
  learningKey,
  LESSON_SALIENCE,
  mergeLessons,
  resolvedEpisodes,
  verdictOf,
  type Episode,
  type LearningRecord,
} from "./learning.js";
import type { ProposedAction } from "./types.js";

/**
 * The comparable parts of a proposal.
 *
 * Lives here rather than in the agent because both the live recording path and
 * the back-fill build episodes, and a lesson formed over a mix of the two must
 * be generalising over one feature set rather than two. A key absent from the
 * payload is absent from the features rather than present as "unknown": a
 * constant is not a comparable, and "unknown" across a whole batch is exactly
 * the kind of spurious feature this layer is meant to avoid.
 */
export function buildFeatures(
  payload: Record<string, unknown>,
  channel: string
): Record<string, string> {
  const features: Record<string, string> = {};
  for (const key of ["risk", "pillar", "format"]) {
    const value = payload[key];
    if (typeof value === "string" && value) features[key] = value;
  }
  features["channel"] = channel;
  return features;
}

/** How many of the agent's own rulings to look back over. */
const RULING_LOOKBACK = 100;

/** At most this many claims come back from one formation call. */
const MAX_NEW_CLAIMS = 4;

export const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lessons"],
  properties: {
    lessons: {
      // No maxItems: the API rejects array length constraints in an
      // output_config schema, and doing it anyway 400s the request before the
      // model runs. The cap is stated in the prompt and sliced in code below.
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "basis", "support", "contradict"],
        properties: {
          claim: { type: "string", maxLength: 200 },
          basis: { type: "string", maxLength: 300 },
          support: { type: "integer" },
          contradict: { type: "integer" },
        },
      },
    },
  },
} as const;

interface FormationResult {
  lessons: Array<{ claim: string; basis: string; support: number; contradict: number }>;
}

export async function readLearning(
  db: Supabase,
  agentId: string,
  now: Date
): Promise<LearningRecord> {
  const rows = await db.readMemory({ keys: [learningKey(agentId)], limit: 1 });
  const detail = rows[0]?.detail as Record<string, unknown> | undefined;
  const value = detail?.["value"] as LearningRecord | undefined;
  if (!value || !Array.isArray(value.episodes) || !Array.isArray(value.lessons)) {
    return emptyRecord(now);
  }
  return { ...value, pendingVerdicts: value.pendingVerdicts ?? 0 };
}

/**
 * Persist the record below the broadcast floor.
 *
 * `salience: LESSON_SALIENCE` is the whole retrieval contract. Growth-Strategy
 * and Chief-of-Staff both read memory at `minSalience: 6` with no tag filter, so
 * anything written at 6 or above lands in their prompts on every run. Writing at
 * 4 keeps this out of them by the shape of the query rather than by anyone
 * remembering to be careful.
 */
export async function writeLearning(
  db: Supabase,
  agentId: string,
  record: LearningRecord
): Promise<void> {
  await db.writeMemory({
    key: learningKey(agentId),
    scope: agentId,
    kind: "pattern",
    content: `${record.lessons.length} lesson(s) held, ${record.episodes.length} episode(s) on file`,
    detail: { value: record } as Record<string, unknown>,
    salience: LESSON_SALIENCE,
    source_agent: agentId,
    tags: ["lesson", agentId],
  });
}

/**
 * Which stored rulings represent proposals this agent would have recorded.
 *
 * Selected on the stored `action.type` rather than on the shape of the dedupe
 * key. The key shape is not a stable thing to match against — the historical X
 * rows predate the content hash `dedupeKey` now appends — whereas the action
 * type is the same vocabulary the propose path filters on, so the two cannot
 * drift apart without someone changing both.
 */
export interface BackfillSpec {
  /** Action types the agent records episodes for, mapped to the episode kind. */
  kinds: Readonly<Record<string, Episode["kind"]>>;
  /** The channel, stamped on every reconstruction. */
  channel: string;
}

/**
 * Read this agent's rulings and join them onto the episodes that earned them.
 * Deterministic — no model, and the only cost is the one read.
 *
 * With a `BackfillSpec`, rulings with no episode at all are reconstructed from
 * the stored approval row rather than discarded. See `backfillEpisodes()` for
 * why that is worth doing once and harmless every run after.
 */
export async function absorbVerdicts(
  db: Supabase,
  agentId: string,
  record: LearningRecord,
  now: Date,
  backfill?: BackfillSpec
): Promise<{ record: LearningRecord; resolved: number; backfilled: number }> {
  const approvals = await db.listApprovals("all", RULING_LOOKBACK);
  const mine = approvals.filter((row) => row.agent_id === agentId && row.dedupe_key);

  const applied = applyVerdicts(
    record,
    mine.map((row) => ({
      key: String(row.dedupe_key),
      status: row.status,
      decidedAt: row.decided_at ?? undefined,
    })),
    now
  );
  if (!backfill) return { ...applied, backfilled: 0 };

  const reconstructed: Episode[] = [];
  for (const row of mine) {
    const verdict = verdictOf(row.status);
    if (!verdict) continue;
    const action = row.action as ProposedAction | undefined;
    if (!action) continue;
    const kind = backfill.kinds[action.type];
    if (!kind) continue;

    const payload = (action.payload ?? {}) as Record<string, unknown>;
    reconstructed.push({
      at: row.decided_at ?? row.created_at ?? now.toISOString(),
      key: String(row.dedupe_key),
      kind,
      summary: String(payload["title"] ?? row.title ?? action.summary).slice(0, 200),
      // Built by the same function the live path uses, so a lesson formed over a
      // mixed batch generalises over one feature set rather than two.
      features: buildFeatures(payload, backfill.channel),
      verdict,
      verdictAt: row.decided_at ?? now.toISOString(),
    });
  }

  const filled = backfillEpisodes(applied.record, reconstructed, now);
  return { record: filled.record, resolved: applied.resolved, backfilled: filled.added };
}

/**
 * Turn resolved episodes into claims. One Sonnet call at low effort.
 *
 * Deliberately NOT the reasoning tier. This is reading a small table of
 * decisions and stating what they have in common — classification against
 * evidence in hand, which is what the balanced tier is for. Paying Opus rates
 * hourly to summarise the owner's own rulings would be the "best model
 * everywhere" mistake the model tiers exist to avoid.
 *
 * `maxTokens` is SHORT_ANSWER_MAX_TOKENS because thinking is billed inside
 * max_tokens on this generation: a budget sized for the answer alone is spent
 * before the answer starts, which is the bug that silently killed five agents.
 */
export async function formLessons(
  claude: Claude,
  record: LearningRecord,
  agentName: string
): Promise<LearningRecord | null> {
  const resolved = resolvedEpisodes(record);
  if (resolved.length === 0) return null;

  const table = resolved
    .map((episode) => {
      const features = Object.entries(episode.features)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      return `- [${episode.verdict}] ${episode.kind}: ${episode.summary} (${features})`;
    })
    .join("\n");

  const held = record.lessons.length
    ? record.lessons.map((lesson) => `- ${lesson.claim}`).join("\n")
    : "(none yet)";

  const system = `You maintain the working knowledge of ${agentName}, an agent that proposes work and has it approved or rejected by the business owner.

Below is every proposal the owner has ruled on, with the ruling. Say what those rulings have in common.

Rules:
- State at most ${MAX_NEW_CLAIMS} claims. Fewer is better. No claim at all is a valid answer.
- A claim must be about what the OWNER approves or rejects, and must be actionable when drafting the next proposal.
- Count "support" as the number of rulings above consistent with the claim, and "contradict" as the number inconsistent with it. Count honestly; a claim with more contradictions than support is not worth stating.
- Do not state a claim supported by fewer than two rulings. One ruling is an anecdote.
- Do not restate a claim already held unless the new rulings genuinely strengthen it.
- Do not make claims about the audience, engagement, reach or what readers liked. No such data exists here, and inventing it would put a confident rule on top of nothing.
- Do not make claims about this agent's own configuration or cadence.

Respond only with the JSON object described by the schema.`;

  const user = `Rulings so far:
${table}

Claims already held:
${held}

State what the rulings have in common.`;

  const result = await claude.complete<FormationResult>({
    model: MODELS.balanced,
    system,
    user,
    effort: "low",
    maxTokens: SHORT_ANSWER_MAX_TOKENS,
    schema: LESSON_SCHEMA as unknown as Record<string, unknown>,
  });

  if (!result.parsed) return null;
  const claims = (result.parsed.lessons ?? []).slice(0, MAX_NEW_CLAIMS);
  return demote(mergeLessons(record, claims, new Date()), new Date());
}

/** Build the episodes a run's proposals become, ready to be recorded. */
export function episodesFor(
  proposals: Array<{ key: string; kind: Episode["kind"]; summary: string; features: Record<string, string> }>,
  now: Date
): Episode[] {
  return proposals.map((proposal) => ({
    at: now.toISOString(),
    key: proposal.key,
    kind: proposal.kind,
    summary: proposal.summary.slice(0, 200),
    features: proposal.features,
  }));
}
