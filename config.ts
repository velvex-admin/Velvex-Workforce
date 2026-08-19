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
 * Drawn from what the live site actually claims and sells, so a routine draft
 * is on-message by construction rather than by luck.
 */
export const CONTENT_PILLARS = [
  // Load-bearing dependencies, and the difference between what is visible and
  // what is structural. The core of the offer.
  "structural-architecture",
  // Margin compression, unit economics, cost-per-client against revenue-per-client.
  "margin-and-unit-economics",
  // Channel collision, acquisition dependency, what happens when one channel carries the business.
  "channel-dependency",
  // Whether a model holds under aggressive growth, and what breaks first.
  "scale-readiness",
  // What a bounded third-party diagnostic is, and why it is not consulting.
  "diagnostic-standard",
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

/**
 * Any page matching these needs approval regardless of how small the edit is.
 *
 * /faq is on this list for a specific reason: on the live site it is where the
 * $999 price, the money-back guarantee and the confidentiality commitment are
 * stated. It is a pricing and contract-adjacent page wearing a different name,
 * and the SEO agent must treat it that way.
 */
export const PROTECTED_PAGE_PATTERNS = [
  /^\/pricing/i,
  /^\/plans/i,
  /price/i,
  /^\/faq/i,
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
//
// These eight are the live site's own FAQ, word for word. That is the strongest
// possible reading of "already-approved language": it is text the business has
// already published under its own name.
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
    id: "faq.deliverable",
    matches: ["what do we receive", "what do i get", "what's the output", "deliverable", "end of the process", "what do you deliver"],
    question: "What do we actually receive at the end of the process?",
    approvedAnswer:
      "A single Executive Ledger: a version-controlled, third-party operational health " +
      "assessment covering your Final Velvex Score, the structural reading across all seven " +
      "systems, the six-dimension scoring breakdown, ranked pressure points, and three " +
      "prioritised recommendations for addressing them. It is paired with an executive audio " +
      "briefing: a five-minute, studio-quality AI-narrated summary of the full analysis. " +
      "Together they are a diagnostic and a set of concrete next steps, not an open-ended " +
      "strategy engagement.",
  },
  {
    id: "faq.vs-consultant",
    matches: ["different from a consultant", "why not a consultant", "how is this different", "versus consulting", "consultant"],
    question: "How is this different from hiring a consultant?",
    approvedAnswer:
      "A consultant sells you ongoing execution: ad hoc opinion, strategy hours, a retained " +
      "advisory relationship. Velvex runs a bounded, structural diagnostic. Every finding is " +
      "tagged as observed fact, inference, or assumption, and the engagement closes with three " +
      "prioritised recommendations addressing the specific issues the analysis surfaces. You get " +
      "a defensible read of where your architecture is strained and concrete direction on what to " +
      "do about it, not an open-ended relationship.",
  },
  {
    id: "faq.cost",
    matches: ["how much", "cost", "price", "pricing", "what does it cost", "fee"],
    question: "What does a Velvex diagnostic cost?",
    approvedAnswer:
      "A Velvex diagnostic is normally $999 per engagement, including structured follow-up at 30, " +
      "90 and 180 days after delivery and a money-back guarantee. An introductory rate of $149 is " +
      "in place for the first 10 clients only, after which pricing returns to the standing $999. " +
      "Reach out and we will confirm whether the intro rate is still available.",
  },
  {
    id: "faq.inputs",
    matches: ["what do you need", "what information", "what do we provide", "intake", "what will you ask"],
    question: "What information do you need from us?",
    approvedAnswer:
      "Intake starts with a structured form covering your revenue model, channels, operational " +
      "setup, and available performance data. The more complete the inputs, the fewer assumptions " +
      "the diagnostic has to carry, and every assumption made is disclosed in the Ledger, not " +
      "hidden.",
  },
  {
    id: "faq.timeline",
    matches: ["how long", "timeline", "turnaround", "when will we get", "how fast", "delivery time"],
    question: "How long does the process take?",
    approvedAnswer:
      "There is no queue or batching cycle. Once your intake is reviewed and accepted, your " +
      "diagnostic is completed and delivered within 24 hours.",
  },
  {
    id: "faq.score-defensible",
    matches: ["subjective", "how is the score", "can it be defended", "is the score reliable", "scoring"],
    question: "Is the score subjective, or can it be defended?",
    approvedAnswer:
      "The Final Velvex Score is produced by weighted scoring across six defined dimensions, " +
      "applied consistently to every case through Veĺa. It is not a probabilistic estimate: every " +
      "score is a definitive result, calculated the same way for every engagement, so the same " +
      "underlying structure always produces the same number.",
  },
  {
    id: "faq.confidentiality",
    matches: ["confidential", "data", "nda", "privacy", "who sees", "is our data safe"],
    question: "Is our data kept confidential?",
    approvedAnswer:
      "Yes. Diagnostic intake data is used solely to produce your Executive Ledger. It is not " +
      "shared, published, or reused as a reference case for other engagements without explicit " +
      "consent.",
  },
  {
    id: "faq.fit",
    matches: ["who is this for", "is this for us", "right fit", "our industry", "too small", "too big", "built for"],
    question: "Who is Velvex built for?",
    approvedAnswer:
      "Businesses approaching a scaling decision, whether new capital, new channels, or aggressive " +
      "growth targets, that want a third-party read on whether the underlying architecture can " +
      "hold before resources are committed, rather than after.",
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
