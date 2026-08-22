// What the business actually is.
//
// Taken from the live site (velvex-site.netlify.app), not invented. Every agent
// that writes anything is built against this, so the whole system describes one
// business rather than each agent inventing its own version of it.
//
// If the offer, price or deliverable changes on the site, change it here. It is
// the single place any of that is stated.

export const BUSINESS = {
  name: "Velvex",
  line: "System Evaluation",
  site: "https://velvex-site.netlify.app",
  contact: "velvex.support@gmail.com",

  /** One paragraph, in the register the business actually uses. */
  what:
    "Velvex is an institutional-grade, third-party diagnostic standard for commercial " +
    "architecture. It audits the hidden structural dependencies, operational blind spots " +
    "and category constraints that determine whether a business can survive scale, before " +
    "capital is allocated.",

  /** What it is not. The site is emphatic about this, so agents should be too. */
  isNot: [
    "a consulting firm selling marketing execution or growth tactics",
    "a financial auditor or accounting service",
    "a coaching provider with subjective operational opinions",
    "an open-ended advisory relationship",
  ],

  audience:
    "Businesses approaching a scaling decision — new capital, new channels, aggressive " +
    "growth targets — that want a third-party read on whether the underlying architecture " +
    "holds before resources are committed. Distribution is institutional: B2B enterprises " +
    "and capital allocators.",

  engine: {
    name: "Veĺa",
    version: "v0.1",
    /** The six nodes the site names on the diagnostic interface. */
    nodes: [
      "Structural Architecture",
      "Revenue Mechanics",
      "Channel Dependency",
      "Operational Capacity",
      "Pressure Point Matrix",
      "Continuity Risk",
    ],
    /** The three trajectories every engagement is analysed across. */
    trajectories: [
      "Structural Architecture Mapping",
      "Systemic Integrity Calibration",
      "Vulnerability and Pressure Point Isolation",
    ],
  },

  deliverable:
    "A single Executive Ledger: a version-controlled operational health assessment carrying " +
    "the Final Velvex Score, the structural reading across all seven systems, a " +
    "six-dimension scoring breakdown, ranked pressure points and three prioritised " +
    "recommendations. It is paired with a five-minute executive audio briefing.",

  /**
   * Introductory price for the first 10 clients: $149 per engagement. After
   * those first 10, the price rises to the standing $999. Do not conflate the
   * two: an agent that quotes $999 to a lead who qualifies for the intro rate
   * has invented the wrong number, and an agent that keeps quoting $149 after
   * the seats are filled has misrepresented the offer.
   *
   * Agents that need to state a price should say the intro rate is $149 for
   * the first 10 clients only, then $999 thereafter, and offer to confirm
   * whether seats remain rather than committing to either.
   */
  introPriceUsd: 149,
  introSeats: 10,
  priceUsd: 999,
  turnaround: "Delivered within 24 hours of an accepted intake.",
  guarantee: "Money-back guarantee, with structured follow-up at 30, 90 and 180 days.",

  /** Findings are tagged. Worth agents knowing, because it is the credibility claim. */
  evidenceStandard:
    "Every finding is tagged as observed fact, inference or assumption, and every assumption " +
    "is disclosed rather than hidden.",
} as const;

/**
 * The shared context block dropped into the system prompt of every agent that
 * writes. Keeping it in one string is what stops the channels drifting apart.
 */
export const BUSINESS_CONTEXT = `The business you write for:

${BUSINESS.name} ${BUSINESS.line}. ${BUSINESS.what}

What it is not: ${BUSINESS.isNot.join("; ")}.

Who it is for: ${BUSINESS.audience}

What a client receives: ${BUSINESS.deliverable}

Price: an introductory rate of $${BUSINESS.introPriceUsd} per engagement, for the first ${BUSINESS.introSeats} clients only, after which pricing returns to the standing $${BUSINESS.priceUsd}. Never state one of those two figures without the other, and offer to confirm whether intro seats remain rather than committing either way. ${BUSINESS.turnaround} ${BUSINESS.guarantee}

The diagnostic engine is called ${BUSINESS.engine.name}. ${BUSINESS.evidenceStandard}

Never state a price, a timeline, a score or a guarantee that differs from the above. If something is not stated here, do not invent it: say it will be confirmed properly instead.`;
