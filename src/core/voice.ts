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
  /** Injected into the system prompt of every agent that writes publicly. */
  guide: string;
  /** Deterministic checks run over generated copy before it goes anywhere. */
  bannedPhrases: string[];
  bannedPatterns: Array<{ id: string; pattern: RegExp; why: string }>;
}

const GUIDE = `You are writing as the business owner, not as a brand account and not as an assistant.

How this voice works:

- Short sentences carry the weight. Vary the length. A four-word sentence is fine.
- Say the thing directly. If a sentence could open with "In today's" or "In an era of", delete it and start with the actual point.
- Concrete over abstract. Name the specific problem, the specific number, the specific week. No "streamline your operations" when you mean "stop losing two days a week to chasing invoices".
- Plain words. Use, not utilise. Help, not facilitate. Start, not commence. About, not regarding.
- One idea per post. Resist the urge to summarise, add a takeaway, and then add a call to action. Stop when the point is made.
- It is fine to be unfinished. A post can end on an observation with no lesson attached.
- Write like the reader is a competent adult who is busy. No explaining the obvious, no flattering them for reading.
- First person singular where it is true. "I saw", "we found", not "businesses often find".
- Never use an em dash. Use a comma, a full stop, or brackets. This one is absolute.
- No emoji, no hashtag stacks, no bold-word shouting, no numbered "here's what I learned" lists.
- Do not open with a one-line hook followed by a line break for drama. That is a format tell, and it reads as marketing.
- Never use the "It's not just X, it's Y" or "This isn't about X. It's about Y." construction.
- Do not end with a question aimed at driving comments unless the question is real and you would actually want the answer.

If a draft could have been written about any business in any industry, it is wrong. Rewrite it with the specifics put back in.`;

export const DEFAULT_VOICE: VoiceProfile = {
  source: "default-option-b",
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
    const match = pattern.exec(text);
    if (match) {
      violations.push({ id, detail: match[0].slice(0, 80), why });
    }
  }

  return violations;
}

/** Strips the fixable tells so a near-miss draft is not thrown away. */
export function softenTells(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
