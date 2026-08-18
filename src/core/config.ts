// The already-approved scope.
//
// "Routine" only means something if there is a written-down record of what has
// already been approved. That record is this file. Widening anything here is
// itself an approval decision — which is why it is code you change, not
// something an agent can edit at runtime.

import type { Channel } from "./types.js";

/**
 * Content pillars the content agent may draft within without asking. Anything
 * outside these is a new pillar, which the doc puts on the approval side.
 * Seeded from what VX-03 exists to support; adjust as the business decides.
 */
export const CONTENT_PILLARS = [
  "operational-diagnostics",
  "process-bottlenecks",
  "automation-case-notes",
  "founder-operations",
  "client-outcomes",
] as const;
export type ContentPillar = (typeof CONTENT_PILLARS)[number];

/** Formats already signed off. A new format is a campaign decision, not a draft. */
export const APPROVED_FORMATS = [
  "short-post",
  "long-post",
  "thread",
  "case-note",
  "question-post",
] as const;
export type ContentFormat = (typeof APPROVED_FORMATS)[number];

/** Channels that publish. LinkedIn is here because the external agent posts to it. */
export const PUBLISHING_CHANNELS: Channel[] = ["linkedin", "facebook", "x"];

// ---------------------------------------------------------------------------
// Site / SEO scope. The doc draws this line tighter than the publishing agents
// because the SEO agent edits the live site.
// ---------------------------------------------------------------------------

/** Edits the SEO agent may make on its own. */
export const ROUTINE_SITE_EDITS = [
  "meta_description",
  "title_tag",
  "alt_text",
  "internal_link",
  "on_page_copy",
  "structural_seo", // schema markup, heading hierarchy, canonicals, sitemap
] as const;
export type SiteEditKind = (typeof ROUTINE_SITE_EDITS)[number];

/** Any page matching these needs approval regardless of how small the edit is. */
export const PROTECTED_PAGE_PATTERNS = [
  /^\/pricing/i,
  /^\/plans/i,
  /price/i,
  /^\/terms/i,
  /^\/privacy/i,
  /^\/legal/i,
  /^\/contract/i,
  /^\/refund/i,
  /^\/dpa/i,
  /disclaimer/i,
] as const;

export function isProtectedPage(path: string): boolean {
  return PROTECTED_PAGE_PATTERNS.some((pattern) => pattern.test(path));
}

// ---------------------------------------------------------------------------
// Sales pipeline. Outcome states as already defined in the operations
// dashboard — this project reads the vocabulary, it does not touch that system.
// ---------------------------------------------------------------------------

export const PIPELINE_STATES = [
  "new",
  "contacted",
  "blocked",
  "rejected",
  "pending_payment",
  "active_analysis",
  "concluded",
] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

/** How long a prospect may sit in a state before it counts as stalled. */
export const STALL_THRESHOLD_DAYS: Record<PipelineState, number | null> = {
  new: 3,
  contacted: 7,
  blocked: 14,
  rejected: null, // terminal
  pending_payment: 5,
  active_analysis: 10,
  concluded: null, // terminal
};

// ---------------------------------------------------------------------------
// Finance guardrail. The doc's phrasing: flag the moment cost-per-client
// against revenue-per-client turns unsustainable, rather than after the fact.
// ---------------------------------------------------------------------------

export const FINANCE_GUARDRAIL = {
  /** Below this gross margin, the ratio is heading the wrong way. */
  marginFloor: 0.55,
  /** Cost per client above this share of revenue per client is a warning. */
  costRatioWarning: 0.45,
  /** Above this, it is unsustainable and gets escalated immediately. */
  costRatioCritical: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Engagement. Which inbound message kinds an agent may answer unsupervised.
// ---------------------------------------------------------------------------

export const ENGAGEMENT_CATEGORIES = [
  "praise",
  "simple_factual_question",
  "criticism",
  "insult",
  "public_complaint",
  "sales_enquiry",
  "spam",
  "unclear",
] as const;
export type EngagementCategory = (typeof ENGAGEMENT_CATEGORIES)[number];

/** The doc: replies to praise and simple factual questions are routine. */
export const ROUTINE_ENGAGEMENT: readonly EngagementCategory[] = [
  "praise",
  "simple_factual_question",
];

/**
 * Below this confidence, a category call is not trusted and the reply is
 * queued instead. Deliberately high: the cost of mislabelling a complaint as
 * praise is a public reply in the wrong register.
 */
export const ENGAGEMENT_CONFIDENCE_FLOOR = 0.85;

// ---------------------------------------------------------------------------
// Objection / FAQ. Known questions with language that has already been
// approved. Answering from this set is routine; anything else is not.
// ---------------------------------------------------------------------------

export interface FaqEntry {
  id: string;
  /** Cues used for a first-pass match before the model is asked to confirm. */
  matches: string[];
  question: string;
  approvedAnswer: string;
}

export const FAQ_LIBRARY: FaqEntry[] = [
  {
    id: "faq.what-is-the-diagnostic",
    matches: ["what do you do", "what is the diagnostic", "what does it involve", "how does it work"],
    question: "What does the diagnostic actually involve?",
    approvedAnswer:
      "We look at how work moves through your business end to end, find where it stalls, " +
      "and hand you back a written breakdown of what is costing you time and what to fix first. " +
      "No software to install, and nothing changes on your side while we look.",
  },
  {
    id: "faq.how-long",
    matches: ["how long", "timeline", "turnaround", "when will i get"],
    question: "How long does it take?",
    approvedAnswer:
      "Most of the work lands within a week of getting what we need from you. " +
      "If anything is going to take longer than that, you hear it from us before it does.",
  },
  {
    id: "faq.what-do-you-need",
    matches: ["what do you need from me", "what do i have to provide", "how much of my time"],
    question: "What do you need from me?",
    approvedAnswer:
      "A short call, and access to whatever already describes how your process runs today. " +
      "If that does not exist in writing, the call covers it. Expect under an hour of your time.",
  },
  {
    id: "faq.data-handling",
    matches: ["data", "confidential", "nda", "privacy", "secure"],
    question: "What happens to our data?",
    approvedAnswer:
      "It stays between us, it is only used to produce your analysis, and we will sign an NDA " +
      "before anything is shared if you want one in place first.",
  },
  {
    id: "faq.industry-fit",
    matches: ["does this work for", "our industry", "are we too small", "too big"],
    question: "Does this work for a business like ours?",
    approvedAnswer:
      "The method is about how work moves, not about a particular industry, so it travels well. " +
      "If we look and decide you are not a fit, we will tell you that rather than sell you something.",
  },
];

/** Anything a prospect asks that is not clearly one of the above is new. */
export function findFaqEntry(question: string): FaqEntry | null {
  const normalised = question.toLowerCase();
  for (const entry of FAQ_LIBRARY) {
    if (entry.matches.some((cue) => normalised.includes(cue))) return entry;
  }
  return null;
}
