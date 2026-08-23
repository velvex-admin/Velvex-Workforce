// Shared vocabulary for the whole system.
//
// The important idea in this file is ProposedAction: an agent never performs an
// action directly. It proposes one, the autonomy boundary classifies it, and
// only then does anything happen. That is what makes "routine vs needs
// approval" enforceable rather than aspirational.

export type AgentBatch =
  | "marketing"
  | "sales_management"
  | "executive"
  | "intelligence"
  | "orchestration";

export type AgentId =
  // Marketing
  | "content"
  | "linkedin"
  | "facebook"
  | "x"
  | "seo_site"
  | "marketing_analytics"
  | "social_engagement"
  // Sales management
  | "lead_pipeline"
  | "objection_faq"
  // Executive
  | "finance_watch"
  | "ops_health"
  | "site_integrity"
  | "growth_strategy"
  // Intelligence
  | "competitive_intel"
  // Orchestration
  | "chief_of_staff";

export type Channel = "linkedin" | "facebook" | "x" | "site" | "internal";

/** Every kind of thing an agent can ask to do. */
export type ActionType =
  | "draft_content"
  | "publish_post"
  | "schedule_post"
  | "new_content_pillar"
  | "campaign_direction"
  | "campaign_type"
  | "paid_promotion"
  | "site_edit"
  | "reply_public"
  | "reply_dm"
  | "faq_answer"
  | "faq_entry_add"
  | "client_facing_action"
  | "pipeline_flag"
  | "observation"
  | "recommendation"
  /**
   * A researched document written into the agent's own library. It reaches
   * nobody outside this system, which is why it sits on the observe-only side
   * of the runner alongside "observation".
   */
  | "intel_brief"
  | "memory_write";

/**
 * A thing an agent wants to do, before anyone has decided whether it may.
 * `payload` is what the executor receives verbatim, so an approved proposal
 * runs exactly what was reviewed.
 */
export interface ProposedAction {
  type: ActionType;
  summary: string;
  channel?: Channel;
  /** Post id, page path, thread id, prospect id — whatever the action acts on. */
  target?: string;
  payload: Record<string, unknown>;
  /** Why the agent thinks this is worth doing. Shown in the approval queue. */
  rationale?: string;
  /**
   * Set when the action carries out something already approved — a channel
   * agent publishing a draft the content agent got signed off, for example.
   */
  approvedContentRef?: string;
  /** Stops the same proposal queueing again on every tick. */
  dedupeKey?: string;
  reversible?: boolean;
  /** Money leaving the business, in the smallest currency unit. */
  spendMinorUnits?: number;
}

export type Classification = "routine" | "needs_approval";

/** The autonomy boundary's verdict, and which rule produced it. */
export interface RuleDecision {
  classification: Classification;
  /** e.g. "seo.pricing_or_legal_page" — auditable, not free text. */
  ruleId: string;
  reason: string;
  risk: "low" | "medium" | "high";
}

/** A rule is a predicate plus what it means when the predicate matches. */
export interface AutonomyRule {
  id: string;
  describe: string;
  classification: Classification;
  risk?: "low" | "medium" | "high";
  /**
   * Return a reason string to fire, or null to pass. Async because some
   * judgements (is this comment criticism?) need the model.
   */
  test: (action: ProposedAction, ctx: RuleContext) => Promise<string | null> | string | null;
}

export interface RuleContext {
  agentId: AgentId;
  /** Model-backed judgement, used only where a deterministic test cannot decide. */
  judge: Judge;
  now: Date;
}

/** Narrow, structured classification calls. Implemented in src/lib/judge.ts. */
export interface Judge {
  /** True when `text` falls into any of `categories`. */
  categorize<T extends string>(args: {
    text: string;
    categories: readonly T[];
    instruction: string;
  }): Promise<{ category: T; confidence: number; reason: string }>;
}

export type Outcome = "executed" | "observed" | "no_op" | "failed" | "blocked_inactive";

/** What an agent hands to the Chief-of-Staff after doing (or proposing) something. */
export interface AgentReport {
  agentId: AgentId;
  batch: AgentBatch;
  actionType: ActionType;
  summary: string;
  detail?: Record<string, unknown>;
  outcome: Outcome;
  channel?: Channel;
  externalRef?: string;
  approvalId?: string;
  error?: string;
  usage?: Record<string, unknown>;
  model?: string;
  effort?: string;
}

export interface ExecutionResult {
  outcome: Outcome;
  externalRef?: string;
  detail?: Record<string, unknown>;
  error?: string;
}
