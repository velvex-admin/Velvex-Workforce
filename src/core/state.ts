// Typed views over the memory table.
//
// The agents reason about business state — pipeline, finance, site pages,
// drafts. None of that lives in this project natively, and this project is not
// allowed to reach into the Phase 0 systems that hold some of it. So state
// arrives one of two ways: pushed in through /state/:key on the API, or written
// by an agent that produced it.
//
// The rule everywhere below: when there is no data, agents say so. Nothing here
// invents a number to fill a gap.

import type { Supabase } from "../lib/supabase.js";
import type { PipelineState } from "./config.js";

export const STATE_KEYS = {
  pipeline: "sales.pipeline",
  finance: "finance.snapshot",
  sitePages: "site.pages",
  contentQueue: "content.queue",
  signups: "marketing.signups",
  siteChangeQueue: "site.change_queue",
  channelPerformance: "marketing.channel_performance",
  opsStatus: "ops.pipeline_status",
} as const;

export interface Prospect {
  id: string;
  name?: string;
  state: PipelineState;
  enteredStateAt: string;
  lastTouchAt?: string;
  value?: number;
  note?: string;
}

export interface PipelineSnapshot {
  updatedAt: string;
  prospects: Prospect[];
}

export interface FinanceSnapshot {
  updatedAt: string;
  periodStart: string;
  periodEnd: string;
  /** Minor units (cents) throughout, so nothing rounds twice. */
  revenueMinor: number;
  directCostMinor: number;
  toolingCostMinor?: number;
  paypalFeesMinor?: number;
  clientsServed: number;
  newClients?: number;
}

export interface SitePage {
  path: string;
  title?: string;
  metaDescription?: string;
  wordCount?: number;
  images?: Array<{ src: string; alt?: string }>;
  inboundInternalLinks?: number;
  updatedAt?: string;
}

export interface ContentDraft {
  id: string;
  pillar: string;
  format: string;
  text: string;
  createdAt: string;
  /** True when the draft was produced inside the already-approved scope. */
  withinApprovedScope: boolean;
  /**
   * The channel this draft was written for. When set, only that channel's
   * agent will publish it: LinkedIn posts read differently to X posts, so a
   * strategist that wrote for one is not writing shared copy.
   * Absent means the draft is channel-neutral and any channel may take it.
   */
  channelHint?: "linkedin" | "facebook" | "x";
  /** Which agent produced this draft. */
  authorAgent?: string;
  /** Set when the draft itself needed sign-off and got it. */
  approvalRef?: string;
  publishedOn: Array<{ channel: string; ref: string; at: string }>;
  status: "ready" | "needs_revision" | "retired";
  revisionNote?: string;
}

export interface SignupAttribution {
  updatedAt: string;
  windowDays: number;
  byChannel: Record<string, number>;
}

export interface SiteChange {
  id: string;
  path: string;
  kind: string;
  before: string;
  after: string;
  proposedAt: string;
  status: "waiting_for_site_connection" | "applied";
  approvalRef?: string;
}

async function readJson<T>(db: Supabase, key: string): Promise<T | null> {
  const rows = await db.readMemory({ keys: [key], limit: 1 });
  const detail = rows[0]?.detail;
  if (!detail || typeof detail !== "object") return null;
  const value = (detail as Record<string, unknown>)["value"];
  return (value ?? null) as T | null;
}

async function writeJson<T>(
  db: Supabase,
  key: string,
  value: T,
  summary: string,
  options: { scope?: string; agent?: string; salience?: number; tags?: string[] } = {}
): Promise<void> {
  await db.writeMemory({
    key,
    scope: options.scope ?? "global",
    kind: "fact",
    content: summary,
    detail: { value } as Record<string, unknown>,
    salience: options.salience ?? 6,
    source_agent: options.agent ?? null,
    tags: options.tags ?? [],
  });
}

export const state = {
  read: readJson,
  write: writeJson,

  pipeline: (db: Supabase) => readJson<PipelineSnapshot>(db, STATE_KEYS.pipeline),
  finance: (db: Supabase) => readJson<FinanceSnapshot>(db, STATE_KEYS.finance),
  sitePages: (db: Supabase) => readJson<SitePage[]>(db, STATE_KEYS.sitePages),
  signups: (db: Supabase) => readJson<SignupAttribution>(db, STATE_KEYS.signups),

  async contentQueue(db: Supabase): Promise<ContentDraft[]> {
    return (await readJson<ContentDraft[]>(db, STATE_KEYS.contentQueue)) ?? [];
  },

  async saveContentQueue(db: Supabase, drafts: ContentDraft[]): Promise<void> {
    const ready = drafts.filter((draft) => draft.status === "ready").length;
    await writeJson(
      db,
      STATE_KEYS.contentQueue,
      drafts.slice(0, 100),
      `${ready} drafts ready to publish, ${drafts.length} in the queue`,
      { scope: "content", agent: "content", salience: 7, tags: ["content"] }
    );
  },

  async siteChangeQueue(db: Supabase): Promise<SiteChange[]> {
    return (await readJson<SiteChange[]>(db, STATE_KEYS.siteChangeQueue)) ?? [];
  },

  async saveSiteChangeQueue(db: Supabase, changes: SiteChange[]): Promise<void> {
    const waiting = changes.filter((c) => c.status === "waiting_for_site_connection").length;
    await writeJson(
      db,
      STATE_KEYS.siteChangeQueue,
      changes.slice(0, 200),
      `${waiting} site edits written and waiting on a site connection`,
      { scope: "seo_site", agent: "seo_site", salience: 6, tags: ["site", "seo"] }
    );
  },
};

/** Days between a timestamp and now, rounded down. */
export function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}
