// Supabase access over PostgREST. Plain fetch, no SDK: it is a handful of
// endpoints, and Workers already has fetch.
//
// Talks with the service role key, which bypasses RLS. The tables have RLS on
// with no policies, so nothing else can read them.

import { requireSecret, type Env } from "../env.js";
import type { AgentBatch, AgentId, ProposedAction } from "../core/types.js";

export interface ReportRow {
  id?: string;
  created_at?: string;
  agent_id: string;
  agent_batch: AgentBatch;
  action_type: string;
  summary: string;
  detail?: Record<string, unknown>;
  classification?: "routine" | "approved";
  outcome?: string;
  channel?: string | null;
  external_ref?: string | null;
  approval_id?: string | null;
  run_id?: string | null;
  model?: string | null;
  effort?: string | null;
  usage?: Record<string, unknown> | null;
  error?: string | null;
}

export interface MemoryRow {
  id?: string;
  key: string;
  scope?: string;
  kind?: "fact" | "decision" | "preference" | "pattern" | "voice" | "entity" | "metric";
  content: string;
  detail?: Record<string, unknown>;
  salience?: number;
  source_agent?: string | null;
  tags?: string[];
  expires_at?: string | null;
  updated_at?: string;
}

export interface ApprovalRow {
  id?: string;
  created_at?: string;
  agent_id: string;
  agent_batch: AgentBatch;
  title: string;
  rationale: string;
  action: ProposedAction;
  trigger_rule: string;
  trigger_reason?: string;
  risk?: "low" | "medium" | "high";
  status?: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  dedupe_key?: string | null;
  decided_at?: string | null;
  decided_by?: string | null;
  decision_note?: string | null;
  executed_at?: string | null;
  execution_result?: Record<string, unknown> | null;
  error?: string | null;
}

/** A filed intelligence brief. `document` is the whole IntelBrief. */
export interface IntelBriefRow {
  id?: string;
  created_at?: string;
  /** YYYY-MM-DD. Unique: one brief per cycle. */
  brief_date: string;
  title: string;
  headline: string;
  document?: Record<string, unknown>;
  gap_count?: number;
  move_count?: number;
  source_count?: number;
  sources_watched?: number;
  sources_changed?: number;
  web_research?: boolean;
  searches_used?: number;
  model?: string | null;
  cost_usd?: number;
  run_id?: string | null;
}

/**
 * How long one database call may take before it is abandoned.
 *
 * There was no timeout at all, which is the trap already recorded twice in
 * section 10 of CLAUDE.md for Site-Integrity and Ops-Health: a fetch with no
 * signal is not a slow call, it is a call that may never return. This is the
 * one that matters most, because every agent makes several of these on every
 * tick. Measured reads against this project run 0.4-1.3s, so twenty seconds is
 * an outer bound on "something is wrong", not a budget anyone should approach.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Waits before re-sending a call the database could not answer in time.
 *
 * Short on purpose, and the reason is not politeness. Every attempt costs a
 * SUBREQUEST, and a Worker invocation gets roughly fifty for everything it
 * runs — this system has already lost two agents to that budget. Two retries
 * is the most that can be spent without the retry becoming the new failure.
 */
const RETRY_DELAYS_MS = [250, 1_000];

/** Statuses that mean the database was busy rather than the request wrong. */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Whether re-sending this call is SAFE, which is a different question from
 * whether it would help.
 *
 * A 504 is a gateway giving up, not a transaction rolling back: the statement
 * may well have committed before the timeout was reported. So re-sending a
 * plain insert can file the same row twice, and this repo has already paid for
 * that lesson — the LinkedIn partner queue reached 131 copies of one post, and
 * section 10 records the rule that a report which cannot be written must never
 * revise what the run actually did. Two copies of a failure report would be a
 * quieter version of the same thing.
 *
 * So only two shapes are re-sent: a GET, which changes nothing, and an upsert
 * carrying `on_conflict`, where the second write lands on the same key as the
 * first. Every other method fails exactly as it did before.
 */
export function retryableRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  return verb === "POST" && path.includes("on_conflict=");
}

/** Whether the failure itself is worth another attempt. */
export function transientDbFailure(err: unknown): boolean {
  if (err instanceof SupabaseError) return TRANSIENT_STATUSES.has(err.status);
  // An aborted or dropped connection never returned an answer, so nothing is
  // known about whether it ran — which is why only safe methods reach here.
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError" || name === "TypeError";
}

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "SupabaseError";
  }
}

export class Supabase {
  private readonly base: string;
  private readonly key: string;

  /** Overridable so a test can exercise the retry loop without the waiting. */
  private readonly retryDelaysMs: ReadonlyArray<number>;
  private readonly timeoutMs: number;

  constructor(
    env: Env,
    options?: { retryDelaysMs?: ReadonlyArray<number>; timeoutMs?: number }
  ) {
    this.base = env.SUPABASE_URL.replace(/\/+$/, "");
    this.key = requireSecret(env, "SUPABASE_SERVICE_ROLE_KEY");
    this.retryDelaysMs = options?.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { prefer?: string } = {}
  ): Promise<T> {
    const { prefer, ...rest } = init;
    const headers: Record<string, string> = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
      ...((rest.headers as Record<string, string> | undefined) ?? {}),
    };

    const method = rest.method ?? "GET";
    const mayRetry = retryableRequest(method, path);
    let lastError: unknown;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(`${this.base}/rest/v1/${path}`, {
          ...rest,
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();

        if (!res.ok) {
          throw new SupabaseError(
            `Supabase ${method} ${path} failed with ${res.status}`,
            res.status,
            text.slice(0, 500)
          );
        }
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        if (!mayRetry || !transientDbFailure(err)) throw err;
        lastError = err;

        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Out of attempts. The count goes in the message because these reach the
    // owner as an agent's failure, and "the database was busy" and "the
    // database was busy three times running" are different problems.
    const attempts = this.retryDelaysMs.length + 1;
    throw new SupabaseError(
      `Supabase ${method} ${path} failed with ` +
        `${lastError instanceof SupabaseError ? lastError.status : "no response"} ` +
        `after ${attempts} attempts`,
      lastError instanceof SupabaseError ? lastError.status : 0,
      lastError instanceof SupabaseError ? lastError.body : String(lastError)
    );
  }

  // --- reports -------------------------------------------------------------

  async insertReport(row: ReportRow): Promise<ReportRow> {
    const rows = await this.request<ReportRow[]>("reports", {
      method: "POST",
      body: JSON.stringify(row),
      prefer: "return=representation",
    });
    return rows[0]!;
  }

  async listReports(opts: { limit?: number; agentId?: AgentId; batch?: AgentBatch } = {}) {
    const params = new URLSearchParams({
      select: "*",
      order: "created_at.desc",
      limit: String(opts.limit ?? 50),
    });
    if (opts.agentId) params.set("agent_id", `eq.${opts.agentId}`);
    if (opts.batch) params.set("agent_batch", `eq.${opts.batch}`);
    return this.request<ReportRow[]>(`reports?${params}`);
  }

  // --- memory --------------------------------------------------------------

  /** Insert or overwrite by key, so an agent revises its note instead of piling up duplicates. */
  async writeMemory(row: MemoryRow): Promise<MemoryRow> {
    const rows = await this.request<MemoryRow[]>("memory?on_conflict=key", {
      method: "POST",
      body: JSON.stringify(row),
      prefer: "return=representation,resolution=merge-duplicates",
    });
    return rows[0]!;
  }

  async readMemory(opts: {
    scope?: string;
    keys?: string[];
    tags?: string[];
    minSalience?: number;
    limit?: number;
  } = {}): Promise<MemoryRow[]> {
    const params = new URLSearchParams({
      select: "*",
      order: "salience.desc,updated_at.desc",
      limit: String(opts.limit ?? 40),
    });
    if (opts.scope) params.set("scope", `in.(${opts.scope},global)`);
    if (opts.keys?.length) params.set("key", `in.(${opts.keys.join(",")})`);
    if (opts.tags?.length) params.set("tags", `cs.{${opts.tags.join(",")}}`);
    if (opts.minSalience) params.set("salience", `gte.${opts.minSalience}`);
    // Expired notes are not context, they are noise.
    params.append("or", `(expires_at.is.null,expires_at.gt.${new Date().toISOString()})`);
    params.set("superseded_by", "is.null");
    return this.request<MemoryRow[]>(`memory?${params}`);
  }

  // --- pending_approvals ---------------------------------------------------

  /** Returns null when an identical proposal is already queued (dedupe_key clash). */
  async queueApproval(row: ApprovalRow): Promise<ApprovalRow | null> {
    const rows = await this.request<ApprovalRow[]>(
      "pending_approvals?on_conflict=dedupe_key",
      {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "return=representation,resolution=ignore-duplicates",
      }
    );
    return rows[0] ?? null;
  }

  async listApprovals(status: ApprovalRow["status"] | "all" = "pending", limit = 100) {
    const params = new URLSearchParams({
      select: "*",
      order: "created_at.desc",
      limit: String(limit),
    });
    if (status !== "all") params.set("status", `eq.${status}`);
    return this.request<ApprovalRow[]>(`pending_approvals?${params}`);
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    const rows = await this.request<ApprovalRow[]>(
      `pending_approvals?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
    );
    return rows[0] ?? null;
  }

  async updateApproval(id: string, patch: Partial<ApprovalRow>): Promise<ApprovalRow> {
    const rows = await this.request<ApprovalRow[]>(
      `pending_approvals?id=eq.${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" }
    );
    return rows[0]!;
  }

  // --- intel_briefs --------------------------------------------------------

  /**
   * File a brief. Keyed on the date it covers, so a second run on the same day
   * revises that day's brief instead of filing a near-duplicate next to it.
   */
  async upsertIntelBrief(row: IntelBriefRow): Promise<IntelBriefRow> {
    const rows = await this.request<IntelBriefRow[]>("intel_briefs?on_conflict=brief_date", {
      method: "POST",
      body: JSON.stringify(row),
      prefer: "return=representation,resolution=merge-duplicates",
    });
    return rows[0]!;
  }

  /**
   * The library index. `document` is excluded on purpose: the list view shows
   * titles and counts, and pulling every full brief to render a list is how a
   * library page gets slow and expensive at the same time.
   */
  async listIntelBriefs(limit = 50): Promise<IntelBriefRow[]> {
    const params = new URLSearchParams({
      select:
        "id,created_at,brief_date,title,headline,gap_count,move_count,source_count," +
        "sources_watched,sources_changed,web_research,searches_used,model,cost_usd",
      order: "brief_date.desc",
      limit: String(limit),
    });
    return this.request<IntelBriefRow[]>(`intel_briefs?${params}`);
  }

  /** One brief, whole. Accepts either its uuid or the date it covers. */
  async getIntelBrief(handle: string): Promise<IntelBriefRow | null> {
    const column = /^\d{4}-\d{2}-\d{2}$/.test(handle) ? "brief_date" : "id";
    const rows = await this.request<IntelBriefRow[]>(
      `intel_briefs?${column}=eq.${encodeURIComponent(handle)}&select=*&limit=1`
    );
    return rows[0] ?? null;
  }

  /**
   * Whether migration 0002 has been applied.
   *
   * Worth a dedicated probe: without it the intelligence agent's first act on a
   * fresh deployment is an insert that 400s, which surfaces as a failed run
   * rather than as "the migration has not been run". The agent calls this
   * first and stops cleanly; the dashboard shows the same answer.
   */
  async intelReady(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request<unknown>("intel_briefs?select=id&limit=1");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Cheap health probe for the dashboard. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request<unknown>("reports?select=id&limit=1");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
