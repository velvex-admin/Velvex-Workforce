// The handle that stops the same proposal queueing on every tick.
//
// `dedupe_key` is unique across the whole pending_approvals table, and nothing
// clears it. So the key decides not just "is this already waiting" but "may
// this ever be raised again" — a rejected row holds its key forever.
//
// That made a rejection permanent and silent. /faq.html has no meta
// description; the SEO agent proposed one on 2026-08-21 quoting $999 without
// the $149 intro rate; it was rightly rejected. Once the pricing prompt was
// fixed the agent drafted a correct replacement and could never queue it: the
// rejected row still held seo_site:seo:meta_description:/faq.html. The agent
// logged "identical proposal already waiting" and went quiet, on a real and
// still-unfixed gap on the pricing page.
//
// So the key now carries the content as well as the finding. Re-proposing the
// same wording is still suppressed, whatever became of the original. Different
// wording is a different proposal and gets its own row.

import type { ProposedAction } from "./types.js";

/**
 * FNV-1a, 32-bit, hex. Deterministic across runs and workers, which a Map
 * iteration order or a random id would not be. Not a security hash: this only
 * has to separate one draft from another.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The parts of a proposal that make it this proposal rather than another one
 * about the same finding. Payload keys are sorted so an object built in a
 * different order still hashes the same.
 */
export function proposalContent(action: ProposedAction): string {
  const payload = action.payload ?? {};
  const entries = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${JSON.stringify(payload[key])}`);
  return [action.type, action.target ?? "", action.summary, ...entries].join("|");
}

/**
 * The column is `text unique` and the caller stores at most MAX_KEY_LENGTH
 * characters, so the key must fit inside that on its own. The hash goes last
 * and the *basis* is what gets shortened, never the hash: truncating the whole
 * string would cut the hash off exactly when the basis is long, and two long
 * proposals would collide back into one row.
 */
export const MAX_KEY_LENGTH = 300;

/** Stable dedupe handle: the finding, plus the wording it proposes. */
export function dedupeKey(agentId: string, action: ProposedAction): string {
  const hash = contentHash(proposalContent(action));
  const basis =
    action.dedupeKey ?? `${action.type}|${action.target ?? ""}|${action.summary}`;
  const room = MAX_KEY_LENGTH - agentId.length - hash.length - 2; // two colons
  return `${agentId}:${basis.slice(0, Math.max(0, room))}:${hash}`;
}
