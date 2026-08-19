// The voice profile.
//
// Architecture doc, "Voice Requirement": as human as possible is a build
// requirement, not a tone note. The content agent and the social engagement
// agent are the two that write in the business's voice in public, so both are
// built against this profile rather than a generic instruction to sound
// friendly.
//
// This is the doc's Option B — a deliberately non-AI-sounding default, written
// to be corrected once it is seen in action. Replacing it with a profile built
// from real writing samples (Option A) means editing this one file; nothing
// else in the system needs to change.

export type VoiceSource = "default-option-b" | "samples-option-a";

export interface VoiceProfile {
  source: VoiceSource;
  /**
   * The architecture doc names em dashes as the AI tell to avoid, so they are
   * banned. The live site uses them freely, which is a real conflict between
   * the spec and the published brand voice: flip this to true if the site wins.
   * It is one line, and it is the only thing that needs to change.
   */
  allowEmDash: boolean;
  /** Injected into the system prompt of every agent that writes publicly. */
  guide: string;
  /** Deterministic checks run over generated copy before it goes anywhere. */
  bannedPhrases: string[];
  bannedPatterns: Array<{ id: string; pattern: RegExp; why: string }>;
}

const GUIDE = `You write as Velvex. Not as a person with opinions, and not as a brand account with a personality: as the standard itself.

How this voice works:

- Declarative. State what is true about how businesses fail under scale. No hedging, no "we believe", no "in our experience".
- Short sentences, and let a hard one stand alone. A four-word sentence is fine. Absolutes are fine when they are true.
- The vocabulary is structural: load-bearing, dependency, constraint, compression, leakage, pressure point, continuity. Use it because it is precise, not to sound technical.
- Concrete over abstract. Name the specific mechanism: which channel carries the business, which capacity is shared, where the margin actually goes. Never "operational challenges" when you mean "wholesale and DTC draw on the same roasting capacity".
- First person plural, sparingly, and only about what Velvex does. Never first person singular. No anecdotes, no founder story, no "I saw a client last week".
- No selling. No calls to action stacked at the end, no urgency, no "book a call". The reader is an operator or an allocator; they will act if the observation is right.
- One idea per post. Stop when the point lands. A post can end on the observation with nothing appended.
- Findings language matters: if something is inferred rather than observed, say so. Overclaiming is off-brand in a way that bad grammar is not.
- Never use an em dash. Use a comma, a full stop, or a colon. This one is absolute unless the profile says otherwise.
- No emoji, no hashtag stacks, no bold-word shouting, no "here's what I learned" lists.
- Do not open with a one-line hook followed by a line break for drama. That is a format tell and it reads as marketing.
- Never use the "It's not just X, it's Y" or "This isn't about X. It's about Y." construction.
- Do not end with a question aimed at driving comments.

If a draft could have been written about any consultancy in any industry, it is wrong. Put the structural specifics back in.`;

export const DEFAULT_VOICE: VoiceProfile = {
  source: "default-option-b",
  allowEmDash: false,
  guide: GUIDE,
  bannedPhrases: [
    "in today's fast-paced",
    "in today's digital",
    "in an era of",
    "game-changer",
    "game changer",
    "unlock the power",
    "unlock your",
    "take it to the next level",
    "seamless",
    "leverage our",
    "cutting-edge",
    "revolutionize",
    "revolutionise",
    "delve into",
    "navigate the complexities",
    "at the end of the day",
    "moving forward",
    "it's worth noting",
    "in conclusion",
    "let's dive in",
    "buckle up",
    "the bottom line is",
    "here's the thing",
    "elevate your",
    "supercharge",
    "robust solution",
    "holistic approach",
    "best-in-class",
    "thought leader",
    "circle back",
    "low-hanging fruit",
    "synergy",
  ],
  bannedPatterns: [
    {
      id: "em-dash",
      pattern: /[—–]/,
      why: "Em and en dashes are the most recognisable AI tell in short copy.",
    },
    {
      id: "not-just-but",
      pattern: /\b(is|are|it's|its)\s+not\s+just\s+[^.!?]{1,60}\bit'?s\b/i,
      why: 'The "not just X, it\'s Y" construction is a stock AI cadence.',
    },
    {
      id: "isnt-about-its-about",
      pattern: /\b(isn'?t|is not)\s+about\s+[^.!?]{1,60}\.\s*it'?s\s+about\b/i,
      why: 'The "This isn\'t about X. It\'s about Y." construction is a stock AI cadence.',
    },
    {
      id: "rule-of-three-listy",
      pattern: /\b\w+,\s+\w+,\s+and\s+\w+\.\s+(That'?s|This is)\b/i,
      why: "Triplet followed by a summarising sentence is a generated-copy rhythm.",
    },
    {
      id: "hook-then-break",
      pattern: /^.{0,60}[.!?]\n\n.{0,40}[.!?]\n\n/,
      why: "One-line hook then dramatic line breaks is a template, not a voice.",
    },
    {
      id: "engagement-bait",
      pattern: /\bthoughts\?|\bagree\?|\bwho else\b|\bdrop a comment\b|\blet me know below\b/i,
      why: "Comment-bait closers read as marketing, not as the owner talking.",
    },
    {
      id: "emoji",
      // Common decorative emoji ranges. Deliberately narrow: this is a tell
      // check, not a unicode policy.
      pattern: /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u,
      why: "The profile calls for no emoji.",
    },
  ],
};

export interface VoiceViolation {
  id: string;
  detail: string;
  why: string;
}

/**
 * Deterministic pass over generated copy. The model is told the rules; this
 * checks whether it followed them. Anything caught here is fixed or the draft
 * does not go out.
 */
export function scanForTells(text: string, profile: VoiceProfile = DEFAULT_VOICE): VoiceViolation[] {
  const violations: VoiceViolation[] = [];
  const lower = text.toLowerCase();

  for (const phrase of profile.bannedPhrases) {
    if (lower.includes(phrase)) {
      violations.push({
        id: "banned-phrase",
        detail: phrase,
        why: "Phrase is on the banned list in the voice profile.",
      });
    }
  }

  for (const { id, pattern, why } of profile.bannedPatterns) {
    if (id === "em-dash" && profile.allowEmDash) continue;
    const match = pattern.exec(text);
    if (match) {
      violations.push({ id, detail: match[0].slice(0, 80), why });
    }
  }

  return violations;
}

/** Strips the fixable tells so a near-miss draft is not thrown away. */
export function softenTells(text: string, profile: VoiceProfile = DEFAULT_VOICE): string {
  const withoutDashes = profile.allowEmDash
    ? text
    : text.replace(/\s*—\s*/g, ", ").replace(/\s*–\s*/g, ", ");
  return withoutDashes.replace(/[ \t]{2,}/g, " ").trim();
}
