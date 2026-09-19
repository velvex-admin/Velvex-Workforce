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

  /**
   * WHO THE LEDGER IS WRITTEN FOR, which is a different question from who is
   * in the room when a business decides to buy one.
   *
   * This line named "capital allocators" as an audience until 2026-09-19, and
   * `intel.position` says the opposite in the owner's own words: the Ledger is
   * "addressed to the operating business itself, never to capital allocators
   * directly". `intel.position` outranks the public record and outranks this
   * file, so the site's phrasing was the stale half of that disagreement, not
   * the authority — see section 10 on checking this file against the position
   * statement rather than against the site alone.
   *
   * The contradiction mattered more here than anywhere else it was written
   * down. BUSINESS_CONTEXT is rendered in FULL into the system prompt of every
   * agent that writes anything, so an allocator named as the audience puts all
   * public copy into the allocator register — writing to the person across the
   * table from the reader rather than to the reader. Approved positioning notes
   * reach two agents as a one-line title; this string reaches every one of them
   * whole, which is why it is the line that had to be right.
   *
   * "Institutional" is kept, because it describes the register and the tier and
   * that much the site means correctly. What is dropped is the claim that an
   * allocator is who the Ledger is addressed to. If allocators turn out to be a
   * route by which a business arrives, that is a distribution fact and belongs
   * in a field of its own: it is not this one, and nothing here should be read
   * as inventing one.
   */
  audience:
    "Businesses approaching a scaling decision — new capital, new channels, aggressive " +
    "growth targets — that want a third-party read on whether the underlying architecture " +
    "holds before resources are committed. The Ledger is written to be read by the " +
    "operating business itself, and is never addressed to a capital allocator sitting " +
    "across the table from them. The register is institutional; the reader is the operator.",

  engine: {
    name: "Veĺa",
    version: "v1.0",
    /**
     * The seven engines of the Velvex Diagnostic Language, which is the
     * qualitative structural reading.
     *
     * These replaced six differently-named "nodes" and a v0.1 label that this
     * file carried for months. The old set was faithfully copied from the site,
     * and the site was behind the product: the engine had moved to v1.0 and to
     * these seven while every writing agent was still being handed the old
     * vocabulary in its system prompt. Copy written from a superseded model of
     * your own product is the quiet kind of wrong — it reads fine and
     * contradicts the page it points at.
     */
    engines: [
      "Value Engine",
      "Demand Engine",
      "Delivery Engine",
      "Trust Engine",
      "Cashflow Structure",
      "Adaptation Capacity",
      "Exposure Surface",
    ],
    /** The six dimensions of the Velvex Scoring Logic, weighted by AHP. */
    dimensions: [
      "Market Position",
      "Offer Structure",
      "Customer Acquisition",
      "Conversion Systems",
      "Operations",
      "Growth Leverage",
    ],
    /**
     * The stages an engagement passes through. The old "three trajectories" are
     * gone from the site and from the product; this is what replaced them.
     */
    stages: [
      "VEF Eligibility Review — industry legitimacy, operational integrity, representation and marketing",
      "VDL structural reading across the seven engines",
      "VSL survivability scoring across the six dimensions, resolving to the Final Velvex Score",
      "VHM health state, the band the score resolves into",
    ],
  },

  deliverable:
    "A single Executive Ledger: a version-controlled operational health assessment carrying " +
    "the Final Velvex Score, the structural reading across all seven engines, the " +
    "six-dimension scoring breakdown, the health state, ranked pressure points and three " +
    "prioritised recommendations. It is paired with a five-minute executive audio briefing.",

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

  /**
   * The structural fact the positioning rests on. This is NOT the same claim as
   * "a consulting firm..." or "an open-ended advisory relationship" in `isNot`
   * above, and the difference is the whole point.
   *
   * Those are semantic denials, and the 2026-08-28 competitive brief measured
   * them as table stakes: For The TECH Of It publishes almost the identical
   * sentence ("The diagnostic is a flat rate deliverable not a consulting
   * engagement") at $1,497, and Level Up Professional Services runs its own
   * "This Is Not" list naming a scorecard. Declaring what you are not no longer
   * distinguishes anything in this category.
   *
   * What cannot be copied is the absence itself. A provider carrying delivery
   * revenue cannot credibly call its own diagnostic terminal, because the
   * finding that recommends more work is the finding that pays them, and every
   * buyer eventually works that out. Level Up credits its $2,500 AUD fee
   * against the delivery engagement; Value Builder System gives its score away
   * and routes it into a certified advisor network. Velvex has nothing
   * downstream to sell, so it can write this sentence and they cannot.
   *
   * It has to live HERE, not only on the site, because BUSINESS_CONTEXT closes
   * with "if something is not stated here, do not invent it". Until this field
   * existed, every writing agent was forbidden from using the strongest
   * differentiator the business has.
   */
  terminal:
    "Velvex has no delivery arm and sells nothing downstream of the Ledger: no delivery " +
    "engagement, no advisor referral, no fee credited toward later work, no retainer. The " +
    "three prioritised recommendations are executed by the client or by anyone they choose, " +
    "never by Velvex. The structured follow-up at 30, 90 and 180 days is a check on the " +
    "Ledger rather than a next step, and the money-back guarantee sits on the Ledger itself " +
    "rather than on work Velvex is paid to deliver afterwards. State this absence " +
    "structurally rather than resting on the label: \"we do not sell the work the Ledger " +
    "recommends\" is a sentence a provider who credits a diagnostic fee against delivery " +
    "cannot write.",

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

What happens after: ${BUSINESS.terminal}

Price: an introductory rate of $${BUSINESS.introPriceUsd} per engagement, for the first ${BUSINESS.introSeats} clients only, after which pricing returns to the standing $${BUSINESS.priceUsd}. Never state one of those two figures without the other, and offer to confirm whether intro seats remain rather than committing either way. ${BUSINESS.turnaround} ${BUSINESS.guarantee}

The diagnostic engine is called ${BUSINESS.engine.name}, currently ${BUSINESS.engine.version}. Its structural reading names seven engines: ${BUSINESS.engine.engines.join(", ")}. Its scoring names six dimensions: ${BUSINESS.engine.dimensions.join(", ")}. Use those names and no others; earlier material describing six "nodes" or a v0.1 engine is superseded. ${BUSINESS.evidenceStandard}

Never state a price, a timeline, a score or a guarantee that differs from the above. If something is not stated here, do not invent it: say it will be confirmed properly instead.`;
