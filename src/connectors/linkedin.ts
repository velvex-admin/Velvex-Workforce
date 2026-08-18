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

/** Called when a draft is cleared to go out on LinkedIn. */
export async function enqueueForPartner(
  db: Supabase,
  item: Omit<LinkedInQueueItem, "id" | "createdAt" | "status">
): Promise<LinkedInQueueItem> {
  const queued: LinkedInQueueItem = {
    ...item,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "queued",
  };
  const items = await readQueue(db);
  items.unshift(queued);
  await writeQueue(db, items.slice(0, 200));
  return queued;
}

/** The partner agent collecting its work. Marks what it takes. */
export async function collectQueue(db: Supabase, markCollected = true): Promise<LinkedInQueueItem[]> {
  const items = await readQueue(db);
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
