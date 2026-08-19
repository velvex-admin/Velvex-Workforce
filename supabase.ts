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

  constructor(env: Env) {
    this.base = env.SUPABASE_URL.replace(/\/+$/, "");
    this.key = requireSecret(env, "SUPABASE_SERVICE_ROLE_KEY");
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

    const res = await fetch(`${this.base}/rest/v1/${path}`, { ...rest, headers });
    const text = await res.text();

    if (!res.ok) {
      throw new SupabaseError(
        `Supabase ${rest.method ?? "GET"} ${path} failed with ${res.status}`,
        res.status,
        text.slice(0, 500)
      );
    }
    return (text ? JSON.parse(text) : null) as T;
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
