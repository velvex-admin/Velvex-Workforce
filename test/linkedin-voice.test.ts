// The LinkedIn page already has a voice, and the agent starts by not knowing it.
//
// Two failures were possible here and they are different from each other.
//
// The first is arriving generic. `readChannelHistory` reads what THIS SYSTEM
// published, which on a page it has never posted to is nothing — so the model
// would be told "nothing published on this channel yet" about a page with a
// year of posts on it, and would invent a register out of the guide alone. The
// baseline fixes that, and it carries the page's own rejected register as well
// as its target one, because the contrast is where the judgement is.
//
// The second is publishing before the owner has seen it. On every other channel
// publishing a draft the strategist wrote, into an established slot, is routine.
// On a company page still finding its register that is the wrong default: the
// cost of one generic post is not one bad post, it is every reader who now reads
// the page as automated. So publishing here is a veto, and — this is the part
// that is easy to leave out — a rejected draft has to LEAVE the running, or the
// stable dedupe key means the same draft is re-picked, silently fails to
// re-queue, and the channel goes quiet instead of writing something else.

import { describe, expect, it } from "vitest";
import { linkedInAgent } from "../src/agents/marketing/linkedin.js";
import { xAgent } from "../src/agents/marketing/x.js";
import { evaluate } from "../src/core/autonomy.js";
import { planKey, type StoredPlan } from "../src/core/schedule.js";
import { state, type ContentDraft } from "../src/core/state.js";
import channelAgentSource from "../src/agents/marketing/channel-agent.ts?raw";
import linkedInSource from "../src/agents/marketing/linkedin.ts?raw";
import { DEFAULT_VOICE } from "../src/core/voice.js";
import voice from "../db/seeds/linkedin-voice.json";
import { fixedJudge } from "./helpers.js";
import type { AgentDefinition, RunContext } from "../src/core/agent.js";
import type { ApprovalRow, Supabase } from "../src/lib/supabase.js";
import type { ProposedAction } from "../src/core/types.js";
import type { Env } from "../src/env.js";

const NOW = new Date("2026-09-02T15:00:00Z"); // a Wednesday
const SLOT = "2026-09-02T14:00:00.000Z";

function publishAction(draftId: string): ProposedAction {
  return {
    type: "publish_post",
    summary: "Publish to linkedin: ...",
    channel: "linkedin",
    target: draftId,
    approvedContentRef: draftId,
    payload: { draftId, text: "a structural observation", withinApprovedScope: true },
  };
}

async function decide(agent: AgentDefinition, action: ProposedAction) {
  return evaluate({
    action,
    ctx: { agentId: agent.id, judge: fixedJudge("praise"), now: NOW },
    routineRules: agent.routineRules,
    approvalRules: agent.approvalRules,
    approvedChannels: agent.approvedChannels,
  });
}

describe("nothing reaches the company page unread", () => {
  it("queues a LinkedIn publish even though the strategist wrote the draft itself", async () => {
    const decision = await decide(linkedInAgent, publishAction("draft-1"));
    expect(decision.classification).toBe("needs_approval");
    expect(decision.ruleId).toBe("linkedin.publish_needs_sign_off");
  });

  it("queues a scheduled post too, not just an immediate one", async () => {
    // Otherwise "schedule it" is a way around the gate.
    const decision = await decide(linkedInAgent, {
      ...publishAction("draft-1"),
      type: "schedule_post",
    });
    expect(decision.classification).toBe("needs_approval");
  });

  it("leaves X publishing routine, because only LinkedIn asked for this", async () => {
    const decision = await decide(xAgent, {
      ...publishAction("draft-1"),
      channel: "x",
      summary: "Publish to x: ...",
    });
    expect(decision.classification).toBe("routine");
    expect(decision.ruleId).toBe("x.publish_own_draft");
  });

  it("still lets LinkedIn drafting itself run without asking", async () => {
    // The gate is on publishing. Drafting into the shelf must stay routine or
    // the owner is approving twice for one post.
    const decision = await decide(linkedInAgent, {
      type: "draft_content",
      summary: "Draft for linkedin",
      channel: "internal",
      payload: {
        pillar: "channel-dependency",
        format: "short-post",
        voiceClean: true,
        channelHint: "linkedin",
      },
    });
    expect(decision.classification).toBe("routine");
  });
});

// ---------------------------------------------------------------------------

function fakeDb(rejected: ApprovalRow[] = []): Supabase {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async writeMemory(row: { key: string }) {
      rows.set(row.key, row as Record<string, unknown>);
      return row;
    },
    async readMemory(opts: { keys?: string[] } = {}) {
      const key = opts.keys?.[0];
      const row = key ? rows.get(key) : undefined;
      return row ? [row] : [];
    },
    async listReports() {
      return [];
    },
    async listApprovals(status: string) {
      return status === "rejected" || status === "all" ? rejected : [];
    },
  } as unknown as Supabase;
}

function draft(id: string): ContentDraft {
  return {
    id,
    pillar: "channel-dependency",
    format: "short-post",
    text: `Draft ${id}: channel concentration reads as efficiency until expansion.`,
    createdAt: "2026-09-01T09:00:00Z",
    withinApprovedScope: true,
    channelHint: "linkedin",
    authorAgent: "linkedin",
    publishedOn: [],
    status: "ready",
  };
}

function rejectedPublish(draftId: string): ApprovalRow {
  return {
    agent_id: "linkedin",
    agent_batch: "marketing",
    title: "Publish to linkedin",
    rationale: "the owner read it and said no",
    trigger_rule: "linkedin.publish_needs_sign_off",
    status: "rejected",
    dedupe_key: `linkedin:publish:linkedin:${SLOT}`,
    decided_at: "2026-09-02T14:30:00Z",
    action: publishAction(draftId),
  } as ApprovalRow;
}

async function propose(drafts: ContentDraft[], rejected: ApprovalRow[] = []) {
  const db = fakeDb(rejected);
  await state.saveContentQueue(db, drafts);
  const plan: StoredPlan = { week: "2026-08-31", slots: [SLOT], consumed: [] };
  await db.writeMemory({ key: planKey("linkedin"), detail: { value: plan } } as never);

  const logs: string[] = [];
  const ctx = {
    db,
    env: {} as unknown as Env,
    now: NOW,
    log: (line: string) => logs.push(line),
    claude: {
      complete: async () => {
        throw new Error("stubbed: no model in this test");
      },
    },
  } as unknown as RunContext;

  const proposals = await linkedInAgent.propose(ctx);
  return { proposals, logs, db };
}

describe("a draft the owner turned down", () => {
  it("is not proposed again", async () => {
    const { proposals } = await propose([draft("a")], [rejectedPublish("a")]);
    expect(proposals.filter((p) => p.type === "publish_post")).toHaveLength(0);
  });

  it("is recorded as declined on this channel, not deleted or retired", async () => {
    // Per channel, like publishedOn: a channel-neutral draft turned down for
    // LinkedIn may still be right for X, and retiring it would take that away.
    const { db } = await propose([draft("a")], [rejectedPublish("a")]);
    const saved = await state.contentQueue(db);
    expect(saved[0]?.declinedOn).toEqual([{ channel: "linkedin", at: NOW.toISOString() }]);
    expect(saved[0]?.status).toBe("ready");
  });

  it("frees the shelf so the agent writes something else", async () => {
    // The whole point of rejecting. With three drafts on the shelf and one
    // declined, the drafting gate must see two and go back to work.
    const { logs } = await propose(
      [draft("a"), draft("b"), draft("c")],
      [rejectedPublish("a")]
    );
    expect(logs.join("\n")).toMatch(/1 draft\(s\) declined by the owner/);
    expect(logs.join("\n")).not.toMatch(/no new draft this run/);
    expect(logs.join("\n")).toMatch(/drafting call failed/);
  });

  it("hands the slot to the next draft rather than stalling on the declined one", async () => {
    const { proposals } = await propose([draft("a"), draft("b")], [rejectedPublish("a")]);
    const publish = proposals.filter((p) => p.type === "publish_post");
    expect(publish).toHaveLength(1);
    expect(publish[0]?.payload["draftId"]).toBe("b");
  });

  it("does not stamp the same decline twice", async () => {
    const already: ContentDraft = {
      ...draft("a"),
      declinedOn: [{ channel: "linkedin", at: "2026-09-01T00:00:00.000Z" }],
    };
    const { logs, db } = await propose([already], [rejectedPublish("a")]);
    expect(logs.join("\n")).not.toMatch(/declined by the owner/);
    const saved = await state.contentQueue(db);
    expect(saved[0]?.declinedOn).toHaveLength(1);
  });
});

describe("the voice the page already has", () => {
  it("ships both halves, because the contrast is the lesson", () => {
    expect(voice.target.length).toBeGreaterThanOrEqual(3);
    expect(voice.avoid.length).toBeGreaterThanOrEqual(2);
    for (const sample of voice.avoid) {
      expect(sample.why.length).toBeGreaterThan(20);
    }
  });

  it("holds up the page's own posts as the target, verbatim", () => {
    const joined = voice.target.map((t) => t.text).join("\n");
    expect(joined).toContain("Operational performance under stable conditions");
    expect(joined).toContain("Channel concentration often appears efficient");
  });

  it("names a call to action and comment bait as what to avoid", () => {
    const joined = voice.avoid.map((a) => `${a.why} ${a.text}`).join("\n");
    expect(joined).toMatch(/Message us directly|Secure your foundational stability/);
    expect(joined).toMatch(/comments below/);
  });

  it("carries no target sample that ends on a call to action", () => {
    // The one way this seed could actively teach the wrong thing.
    for (const sample of voice.target) {
      expect(sample.text).not.toMatch(/message us|visit our website|comments below|book a|get in touch/i);
    }
  });

  it("is used only while this system has published nothing here", () => {
    // Once real history exists it is richer and current, and a frozen baseline
    // sitting beside it would compete with it — the additive-memory failure
    // this repo has already paid for twice.
    expect(channelAgentSource).toMatch(/history\.recentPosts\.length === 0/);
  });
});

describe("the guide the LinkedIn agent writes under", () => {
  // platformGuide is consumed by the factory and goes straight into the system
  // prompt, so it is not readable off the AgentDefinition. The source is.
  it("bans hashtag stacks, which is the one place the page and the guide disagreed", () => {
    expect(linkedInSource).toMatch(/At most ONE hashtag/);
    expect(linkedInSource).toMatch(/Never a stack/);
  });

  it("bans calls to action and comment-bait questions outright", () => {
    expect(linkedInSource).toMatch(/Never write a call to action/);
    expect(linkedInSource).toMatch(/Never end with a question aimed at driving comments/);
  });

  it("holds one spelling convention, since the page currently mixes them", () => {
    expect(linkedInSource).toMatch(/British spelling/);
  });

  it("points at the page's actual openings rather than describing them", () => {
    // A guide that says "be declarative" produces generic copy. A guide that
    // quotes the page's own first sentence does not.
    expect(linkedInSource).toContain("Operational performance under stable conditions");
  });

  it("keeps em dashes banned, which is the owner's call and not the page's", () => {
    // The page uses them; the architecture doc bans them; the owner chose the
    // doc. voice.ts is the single place that decides, so the guide must not
    // quietly re-permit them.
    expect(DEFAULT_VOICE.allowEmDash).toBe(false);
    expect(linkedInSource).not.toMatch(/em dash(es)? (are|is) (fine|allowed|permitted)/i);
  });
});
