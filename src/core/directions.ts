// Approved growth directions, and how one is closed.
//
// An approved `campaign_direction` is written to memory as
// `growth.<channel>.<date>.<id>` at salience 8, tagged `[channel, "growth"]`
// (channel-agent.ts, execute). The channel strategist reads `tags: [channel]` at
// `minSalience: STRATEGIST_MIN_SALIENCE` on every draft, so every approved
// direction is handed to the model as open work, for ever.
//
// Before this module nothing could close one. The owner ruled six X directions
// closed on 2026-09-24, and Growth-Strategy "closed" more in its memo the same
// day, and every one of them was still in the X agent's prompt afterwards: a
// ruling that existed only as text in a note. Retiring a direction drops its
// salience below the strategist's floor, so the channel read cannot match it,
// and tags it `retired` so the record says why. Nothing is deleted: the row is
// the history of what was approved.

import type { MemoryRow, Supabase } from "../lib/supabase.js";

export const DIRECTION_PREFIX = "growth.";

/**
 * The floor the channel strategists read memory at. Shared with
 * channel-agent.ts so a retired direction is below it by construction rather
 * than by a number somebody has to keep in step.
 */
export const STRATEGIST_MIN_SALIENCE = 5;

/** Below every reader's floor: the strategists at 5, the broadcast readers at 6. */
export const RETIRED_SALIENCE = 1;

export const RETIRED_TAG = "retired";

export interface Direction {
  key: string;
  channel: string | null;
  title: string;
  status: "open" | "retired";
  salience: number;
  updatedAt: string | null;
  retiredAt: string | null;
  retiredNote: string | null;
}

export function isDirectionKey(key: string): boolean {
  return key.startsWith(DIRECTION_PREFIX);
}

export function isRetired(row: Pick<MemoryRow, "tags" | "salience">): boolean {
  return (
    (row.tags ?? []).includes(RETIRED_TAG) ||
    (row.salience ?? 0) < STRATEGIST_MIN_SALIENCE
  );
}

export function toDirection(row: MemoryRow): Direction {
  const detail = row.detail ?? {};
  return {
    key: row.key,
    channel: row.key.split(".")[1] ?? null,
    title: row.content,
    status: isRetired(row) ? "retired" : "open",
    salience: row.salience ?? 0,
    updatedAt: row.updated_at ?? null,
    retiredAt: typeof detail["retiredAt"] === "string" ? detail["retiredAt"] : null,
    retiredNote: typeof detail["retiredNote"] === "string" ? detail["retiredNote"] : null,
  };
}

/** Every direction on record, open and retired, newest first within each. */
export async function listDirections(db: Supabase, channel?: string): Promise<Direction[]> {
  const rows = await db.readMemory({
    tags: channel ? [channel, "growth"] : ["growth"],
    limit: 200,
  });
  return rows.filter((row) => isDirectionKey(row.key)).map(toDirection);
}

/** The retired form of a row: below every reader's floor, tagged, and dated. */
export function retiredRow(row: MemoryRow, at: string, note?: string): MemoryRow {
  const tags = row.tags ?? [];
  return {
    key: row.key,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    content: row.content,
    detail: {
      ...(row.detail ?? {}),
      retiredAt: at,
      ...(note ? { retiredNote: note } : {}),
      salienceBeforeRetire: row.salience ?? null,
    },
    salience: RETIRED_SALIENCE,
    source_agent: row.source_agent ?? null,
    tags: tags.includes(RETIRED_TAG) ? tags : [...tags, RETIRED_TAG],
  };
}

export type RetireResult =
  | { ok: true; direction: Direction; alreadyRetired: boolean }
  | { ok: false; status: 400 | 404; error: string };

export async function retireDirection(
  db: Supabase,
  key: string,
  at: string,
  note?: string
): Promise<RetireResult> {
  if (!isDirectionKey(key)) {
    return { ok: false, status: 400, error: `"${key}" is not a direction key; they start "${DIRECTION_PREFIX}"` };
  }
  const [row] = await db.readMemory({ keys: [key], limit: 1 });
  if (!row) return { ok: false, status: 404, error: `No direction "${key}"` };
  if (isRetired(row)) return { ok: true, direction: toDirection(row), alreadyRetired: true };
  const written = await db.writeMemory(retiredRow(row, at, note));
  return { ok: true, direction: toDirection(written), alreadyRetired: false };
}

/**
 * The direction a draft says it served, kept only if it names one that was
 * actually open in the notes the model was shown. Anything else, including a
 * key it invented or "none", is recorded as no direction rather than guessed.
 */
export function servedDirection(claimed: unknown, openKeys: readonly string[]): string | null {
  if (typeof claimed !== "string") return null;
  const key = claimed.trim();
  return openKeys.includes(key) ? key : null;
}
