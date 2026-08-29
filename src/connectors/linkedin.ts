// LinkedIn — integration point only.
//
// Architecture doc: the LinkedIn agent is already being built by an outside
// company and integrates into this system as a connector once ready. So this
// file deliberately contains no agent: no scheduling decisions, no drafting, no
// judgement about what to post. What it contains is the seam the external agent
// plugs into, from both directions.
//
//   outbound  we hold approved drafts; the partner agent collects them and
//             tells us what it published
//   inbound   the partner agent hands us comments and DMs, which our social
//             engagement agent then handles under its own rules
//   metrics   the partner agent reports channel performance, which the
//             marketing analytics agent reads like any other channel
//
// Routes live in src/routes/integrations.ts. The token is a shared secret the
// partner presents; it is unset until they deliver.

import { flag, type Env } from "../env.js";
import type { Supabase } from "../lib/supabase.js";
import type { ChannelMetrics, ConnectorStatus, InboundMessage } from "./types.js";

const QUEUE_KEY = "linkedin.outbound_queue";
const INBOUND_KEY = "linkedin.inbound_buffer";
const METRICS_KEY = "linkedin.metrics";

export interface LinkedInQueueItem {
  id: string;
  text: string;
  /** Set when the content it carries went through the approvals queue. */
  approvalRef?: string;
  pillar?: string;
  format?: string;
  createdAt: string;
  status: "queued" | "collected" | "published";
  publishedRef?: string;
  publishedAt?: string;
  /**
   * Stable identity of the work this item carries — a content draft id, an
   * inbound message id. Two items with the same key are the same piece of
   * work, however many times it was handed over. Optional because rows written
   * before this field existed do not have one; those fall back to their text.
   */
  sourceKey?: string;
}

/**
 * What makes an item this item rather than another. The caller-supplied key is
 * preferred: it is exact, and it survives the copy being re-drafted. Text is
 * the fallback for rows queued before keys existed.
 */
export function queueIdentity(item: Pick<LinkedInQueueItem, "text" | "sourceKey">): string {
  if (item.sourceKey) return `key:${item.sourceKey}`;
  return `text:${item.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * Collapse repeats of the same work.
 *
 * This queue filled with one post repeated on every hourly tick. The
 * strategist published into it, the handover was reported as
 * `blocked_inactive` because the partner is not wired up yet, and nothing
 * downstream recorded that the draft had been handed over — so the next tick
 * found the same ready draft and the same unconsumed slot and did it again.
 * The strategist side is fixed in channel-agent.ts; this is the second line of
 * defence, and the thing that heals a queue already full of repeats.
 *
 * Only `queued` rows are ever dropped. A collected or published row is what
 * the partner actually took, so it stays whatever else is in the group.
 */
export function dedupeQueue(items: LinkedInQueueItem[]): LinkedInQueueItem[] {
  const groups = new Map<string, LinkedInQueueItem[]>();
  for (const item of items) {
    const identity = queueIdentity(item);
    const group = groups.get(identity);
    if (group) group.push(item);
    else groups.set(identity, [item]);
  }

  const keep = new Set<string>();
  for (const group of groups.values()) {
    const advanced = group.filter((item) => item.status !== "queued");
    if (advanced.length > 0) {
      // The partner has this one. Every still-queued copy is a repeat of work
      // already taken.
      for (const item of advanced) keep.add(item.id);
      continue;
    }
    // All queued: keep the original, which is the oldest. The array is
    // newest-first, so that is the last one.
    const oldest = group.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    keep.add(oldest.id);
  }

  return items.filter((item) => keep.has(item.id));
}

export function linkedInStatus(env: Env): ConnectorStatus {
  const missing: string[] = [];
  if (!flag(env.LINKEDIN_INTEGRATION_ENABLED)) missing.push('LINKEDIN_INTEGRATION_ENABLED="true"');
  if (!env.LINKEDIN_PARTNER_TOKEN) missing.push("LINKEDIN_PARTNER_TOKEN");
  return {
    channel: "linkedin",
    active: missing.length === 0,
    missing,
    note:
      "External build. This project exposes the integration point only; the agent " +
      "itself is delivered by the outside company.",
  };
}

/** Constant-time comparison so the token cannot be probed a byte at a time. */
export function partnerTokenMatches(env: Env, presented: string | null): boolean {
  const expected = env.LINKEDIN_PARTNER_TOKEN;
  if (!expected || !presented) return false;
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

async function readQueue(db: Supabase): Promise<LinkedInQueueItem[]> {
  const rows = await db.readMemory({ keys: [QUEUE_KEY], limit: 1 });
  const items = rows[0]?.detail?.["items"];
  return Array.isArray(items) ? (items as LinkedInQueueItem[]) : [];
}

/**
 * Read the queue and repair it in the same breath. Nothing that reads this
 * queue wants to see the same post four times, and a repeat that is only
 * hidden at the point of display is still sitting in the table waiting to be
 * collected. Writes back only when something was actually removed.
 */
async function readQueueHealed(
  db: Supabase
): Promise<{ items: LinkedInQueueItem[]; removed: number }> {
  const raw = await readQueue(db);
  const items = dedupeQueue(raw);
  const removed = raw.length - items.length;
  if (removed > 0) await writeQueue(db, items);
  return { items, removed };
}

/** Maintenance: collapse repeats already sitting in the queue. */
export async function compactQueue(
  db: Supabase
): Promise<{ removed: number; remaining: number; waiting: number }> {
  const { items, removed } = await readQueueHealed(db);
  return {
    removed,
    remaining: items.length,
    waiting: items.filter((item) => item.status === "queued").length,
  };
}

async function writeQueue(db: Supabase, items: LinkedInQueueItem[]): Promise<void> {
  await db.writeMemory({
    key: QUEUE_KEY,
    scope: "linkedin",
    kind: "entity",
    content: `${items.filter((i) => i.status === "queued").length} drafts waiting for the LinkedIn partner agent`,
    detail: { items },
    salience: 6,
    source_agent: "content",
    tags: ["linkedin", "integration"],
  });
}

/**
 * Called when a draft is cleared to go out on LinkedIn.
 *
 * Handing over the same work twice is not an error worth failing on, but it
 * must not produce two rows: the partner would publish the post twice. So a
 * second handover of something already in the queue returns the row that is
 * already there and writes nothing.
 */
export async function enqueueForPartner(
  db: Supabase,
  item: Omit<LinkedInQueueItem, "id" | "createdAt" | "status">
): Promise<{ item: LinkedInQueueItem; duplicate: boolean }> {
  const { items } = await readQueueHealed(db);

  const identity = queueIdentity(item);
  const existing = items.find((row) => queueIdentity(row) === identity);
  if (existing) return { item: existing, duplicate: true };

  const queued: LinkedInQueueItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "queued",
  };
  items.unshift(queued);
  await writeQueue(db, items.slice(0, 200));
  return { item: queued, duplicate: false };
}

/** The partner agent collecting its work. Marks what it takes. */
export async function collectQueue(db: Supabase, markCollected = true): Promise<LinkedInQueueItem[]> {
  const { items } = await readQueueHealed(db);
  const waiting = items.filter((item) => item.status === "queued");
  if (markCollected && waiting.length > 0) {
    const collectedIds = new Set(waiting.map((item) => item.id));
    await writeQueue(
      db,
      items.map((item) =>
        collectedIds.has(item.id) ? { ...item, status: "collected" as const } : item
      )
    );
  }
  return waiting;
}

/** The partner agent reporting back what it published. */
export async function markPublished(
  db: Supabase,
  args: { id: string; publishedRef: string; publishedAt?: string }
): Promise<LinkedInQueueItem | null> {
  const items = await readQueue(db);
  const index = items.findIndex((item) => item.id === args.id);
  if (index === -1) return null;

  const updated: LinkedInQueueItem = {
    ...items[index]!,
    status: "published",
    publishedRef: args.publishedRef,
    publishedAt: args.publishedAt ?? new Date().toISOString(),
  };
  items[index] = updated;
  await writeQueue(db, items);
  return updated;
}

/** Comments and DMs handed to us. Our engagement agent picks these up. */
export async function receiveInbound(
  db: Supabase,
  messages: InboundMessage[]
): Promise<number> {
  const rows = await db.readMemory({ keys: [INBOUND_KEY], limit: 1 });
  const existing = Array.isArray(rows[0]?.detail?.["messages"])
    ? (rows[0]!.detail!["messages"] as InboundMessage[])
    : [];

  const seen = new Set(existing.map((message) => message.id));
  const fresh = messages.filter((message) => !seen.has(message.id));
  const merged = [...fresh, ...existing].slice(0, 200);

  await db.writeMemory({
    key: INBOUND_KEY,
    scope: "social_engagement",
    kind: "entity",
    content: `${merged.length} LinkedIn messages buffered for the engagement agent`,
    detail: { messages: merged },
    salience: 5,
    source_agent: "linkedin",
    tags: ["linkedin", "inbound"],
  });
  return fresh.length;
}

export async function takeInbound(db: Supabase): Promise<InboundMessage[]> {
  const rows = await db.readMemory({ keys: [INBOUND_KEY], limit: 1 });
  const messages = Array.isArray(rows[0]?.detail?.["messages"])
    ? (rows[0]!.detail!["messages"] as InboundMessage[])
    : [];
  if (messages.length > 0) {
    await db.writeMemory({
      key: INBOUND_KEY,
      scope: "social_engagement",
      kind: "entity",
      content: "0 LinkedIn messages buffered for the engagement agent",
      detail: { messages: [] },
      salience: 5,
      source_agent: "linkedin",
      tags: ["linkedin", "inbound"],
    });
  }
  return messages;
}

export async function receiveMetrics(db: Supabase, metrics: ChannelMetrics): Promise<void> {
  await db.writeMemory({
    key: METRICS_KEY,
    scope: "marketing_analytics",
    kind: "metric",
    content:
      `LinkedIn, last ${metrics.windowDays} days: ` +
      `${metrics.impressions ?? "?"} impressions, ${metrics.signups ?? 0} signups`,
    detail: metrics as unknown as Record<string, unknown>,
    salience: 7,
    source_agent: "linkedin",
    tags: ["linkedin", "metrics"],
  });
}

export async function readMetrics(db: Supabase): Promise<ChannelMetrics | null> {
  const rows = await db.readMemory({ keys: [METRICS_KEY], limit: 1 });
  const detail = rows[0]?.detail;
  return detail && typeof detail === "object" && "channel" in detail
    ? (detail as unknown as ChannelMetrics)
    : null;
}
