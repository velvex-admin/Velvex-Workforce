// The digest piggybacks on the hourly cron tick rather than owning a cron
// line of its own (the account has none spare — see CLAUDE.md section 9), so
// the thing worth asserting is the gating: it must do nothing on ten of every
// twelve ticks, and nothing twice within the same digest hour.
//
// worker-mailer opens a real TCP socket via cloudflare:sockets, which vitest's
// default environment does not have, so it is mocked here rather than stubbed
// at the fetch layer the way ops-health.test.ts stubs a plain HTTP call.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestDue, maybeSendOpsDigest } from "../src/core/ops-digest.js";
import type { RunContext } from "../src/core/agent.js";

const sent: Array<{ to: unknown; subject: string; text: string; html: string }> = [];
let closed = 0;

// Mailer behaviour the individual tests steer. These are only ever read inside
// function bodies that run during a test, never in the vi.mock factory itself,
// which is what keeps the hoisting legal.
let connectAttempts = 0;
let failConnectTimes = 0;
let hangConnect = false;
let failSend = false;

// vi.mock calls are hoisted above imports by vitest, so this applies before
// ops-digest.ts's own `import { WorkerMailer } from "worker-mailer"` resolves.
vi.mock("worker-mailer", () => ({
  WorkerMailer: {
    async connect() {
      connectAttempts += 1;
      if (connectAttempts <= failConnectTimes) throw new Error("connection refused");
      if (hangConnect) return new Promise(() => {}); // never settles, like a real dead socket
      return {
        async send(msg: { to: unknown; subject: string; text: string; html: string }) {
          if (failSend) throw new Error("550 message rejected");
          sent.push(msg);
        },
        async close() {
          closed++;
        },
      };
    },
  },
}));

type ReportRow = { created_at?: string; summary: string; outcome?: string; detail?: Record<string, unknown> };

function ctxWith(opts: {
  now: string;
  reports?: ReportRow[];
  lastSent?: string | null;
  lastError?: { at: string; error: string };
  withCreds?: boolean;
  to?: string;
}) {
  const writes: Array<{ key: string; content: string; salience?: number }> = [];
  const memoryRows = [
    ...(opts.lastSent ? [{ key: "ops.digest.last_sent", detail: { value: opts.lastSent } }] : []),
    ...(opts.lastError ? [{ key: "ops.digest.last_error", detail: { value: opts.lastError } }] : []),
  ];

  const ctx = {
    env:
      opts.withCreds === false
        ? {}
        : {
            OPS_DIGEST_GMAIL_USER: "adam@velvexbi.com",
            OPS_DIGEST_GMAIL_APP_PASSWORD: "test-app-password",
            ...(opts.to ? { OPS_DIGEST_TO: opts.to } : {}),
          },
    now: new Date(opts.now),
    db: {
      async listReports() {
        return opts.reports ?? [];
      },
      async readMemory() {
        return memoryRows;
      },
      async writeMemory(row: { key: string; content: string; salience?: number }) {
        writes.push(row);
      },
    },
    log: () => {},
  } as unknown as RunContext;

  return { ctx, writes };
}

type MemoryWrite = { key: string; content: string; salience?: number };

const sentKey = (writes: MemoryWrite[]) =>
  writes.filter((w) => w.key === "ops.digest.last_sent");
const errorKey = (writes: MemoryWrite[]) =>
  writes.filter((w) => w.key === "ops.digest.last_error");

beforeEach(() => {
  sent.length = 0;
  closed = 0;
  connectAttempts = 0;
  failConnectTimes = 0;
  hangConnect = false;
  failSend = false;
});

describe("maybeSendOpsDigest", () => {
  it("does nothing outside the two digest hours", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({ now: "2026-09-16T09:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(sent).toHaveLength(0);
  });

  it("does nothing if this hour's slot was already sent", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({
      now: "2026-09-16T05:00:00Z",
      reports: [],
      lastSent: "2026-09-16T05",
    });
    await maybeSendOpsDigest(ctx);
    expect(sent).toHaveLength(0);
  });

  it("reports all clear when every check in the window was healthy", async () => {
    sent.length = 0;
    const { ctx, writes } = ctxWith({
      now: "2026-09-16T05:00:00Z",
      reports: [
        { created_at: "2026-09-16T04:00:00Z", summary: "Operations pipeline healthy: 0.0% error rate, 0 stuck cases", detail: { concerning: false } },
        { created_at: "2026-09-15T18:00:00Z", summary: "Operations pipeline healthy: 0.0% error rate, 0 stuck cases", detail: { concerning: false } },
      ],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/all clear/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.salience).toBe(2); // below the minSalience:6 broadcast floor
  });

  it("flags issues and excludes reports outside the 12h window", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({
      now: "2026-09-16T05:00:00Z",
      reports: [
        { created_at: "2026-09-16T04:00:00Z", summary: "Operations status endpoint returned 500", detail: { active: true } },
        { created_at: "2026-09-15T10:00:00Z", summary: "Operations pipeline healthy: 0.0% error rate, 0 stuck cases", detail: { concerning: false } }, // >12h old, excluded
      ],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/1 issue/);
  });

  it("pulls issues into their own callout in the HTML, ahead of the full log", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({
      now: "2026-09-16T05:00:00Z",
      reports: [
        { created_at: "2026-09-16T04:00:00Z", summary: "Operations status endpoint returned 500", detail: { active: true } },
        { created_at: "2026-09-16T03:00:00Z", summary: "Operations pipeline healthy: 0.0% error rate, 0 stuck cases", detail: { concerning: false } },
      ],
    });
    await maybeSendOpsDigest(ctx);
    const html = sent[0]!.html;
    const calloutIndex = html.indexOf("What needs a look");
    const logIndex = html.indexOf("Full check log");
    expect(calloutIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeGreaterThan(calloutIndex); // callout reads first
    expect(html).toContain("Operations status endpoint returned 500");
  });

  it("subject leads with an icon and the verdict, not the sender name, for notification-preview scanning", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({
      now: "2026-09-16T05:00:00Z",
      reports: [{ created_at: "2026-09-16T04:00:00Z", summary: "healthy", detail: { concerning: false } }],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.subject.startsWith("✅")).toBe(true);
  });

  it("flags a run with no data as its own kind of issue", async () => {
    sent.length = 0;
    const { ctx } = ctxWith({ now: "2026-09-16T17:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.subject).toMatch(/no data/);
  });

  it("does not throw and does not mark itself sent when Gmail credentials are not configured", async () => {
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [], withCreds: false });
    await expect(maybeSendOpsDigest(ctx)).resolves.not.toThrow();
    expect(sent).toHaveLength(0);
    // Asserted on the SENT key rather than on "no writes at all", which is what
    // this used to say. A failed digest now deliberately writes an error row,
    // so a blanket count would fail for the one reason we want it to pass.
    expect(sentKey(writes)).toHaveLength(0);
    expect(errorKey(writes)).toHaveLength(1);
  });

  it("always closes the SMTP connection after sending", async () => {
    sent.length = 0;
    closed = 0;
    const { ctx } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The schedule, which is the half that actually failed in production.
//
// Between 2026-09-15 and 2026-09-17 the cron tick fired at all four digest
// hours and exactly one email went out. Nothing retried, nothing caught up,
// and the reason for each miss was written to ctx.log — an array the cron
// handler collects and never prints. So these assert the rules directly rather
// than through the mailer: a schedule only reachable through SMTP is a
// schedule nobody tests.
// ---------------------------------------------------------------------------

describe("digestDue", () => {
  it("sends on a digest hour", () => {
    expect(digestDue(new Date("2026-09-16T05:00:00Z"), "2026-09-15T17")).toBe("slot");
    expect(digestDue(new Date("2026-09-16T17:00:00Z"), "2026-09-16T05")).toBe("slot");
  });

  it("stays quiet on an ordinary hour when the last digest is recent", () => {
    expect(digestDue(new Date("2026-09-16T09:00:00Z"), "2026-09-16T05")).toBeNull();
  });

  it("never sends twice in the same hour, by either rule", () => {
    expect(digestDue(new Date("2026-09-16T05:00:00Z"), "2026-09-16T05")).toBeNull();
    // The :30 integrity tick lands in the same hour as the :00 one and shares
    // the slot id, which is what stops it from sending a second copy.
    expect(digestDue(new Date("2026-09-16T05:30:00Z"), "2026-09-16T05")).toBeNull();
    // And an overdue catch-up that just fired cannot immediately re-fire.
    expect(digestDue(new Date("2026-09-16T06:30:00Z"), "2026-09-16T06")).toBeNull();
  });

  it("catches up on the next ordinary tick when a digest hour was missed", () => {
    // THE REGRESSION. 17:00 went out, 05:00 failed. Before this rule the next
    // email was at 17:00 — twelve hours of silence bought by one bad minute.
    expect(digestDue(new Date("2026-09-16T05:00:00Z"), "2026-09-15T17")).toBe("slot");
    expect(digestDue(new Date("2026-09-16T06:00:00Z"), "2026-09-15T17")).toBe("overdue");
    expect(digestDue(new Date("2026-09-16T07:00:00Z"), "2026-09-15T17")).toBe("overdue");
  });

  it("re-anchors on the next digest hour after a catch-up, rather than drifting", () => {
    // Caught up at 06:00; the 17:00 slot is still the next send, so the rhythm
    // returns on its own instead of walking an hour later every cycle.
    expect(digestDue(new Date("2026-09-16T17:00:00Z"), "2026-09-16T06")).toBe("slot");
    expect(digestDue(new Date("2026-09-16T16:00:00Z"), "2026-09-16T06")).toBeNull();
  });

  it("does not catch up when nothing was ever sent", () => {
    // A fresh deploy should land its first email on a real digest hour, not on
    // whichever tick happens to follow the deploy.
    expect(digestDue(new Date("2026-09-16T09:00:00Z"), null)).toBeNull();
    expect(digestDue(new Date("2026-09-16T05:00:00Z"), null)).toBe("slot");
  });

  it("treats an unreadable stored slot as no licence to catch up", () => {
    expect(digestDue(new Date("2026-09-16T09:00:00Z"), "not-a-date")).toBeNull();
  });

  it("does not fire on a clock that reads backwards", () => {
    expect(digestDue(new Date("2026-09-16T09:00:00Z"), "2026-09-20T05")).toBeNull();
  });
});

describe("maybeSendOpsDigest — recovery", () => {
  it("sends the overdue digest outside the digest hours", async () => {
    const { ctx, writes } = ctxWith({
      now: "2026-09-16T06:00:00Z",
      lastSent: "2026-09-15T17",
      reports: [{ created_at: "2026-09-16T04:00:00Z", summary: "healthy", detail: { concerning: false } }],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent).toHaveLength(1);
    expect(sentKey(writes)[0]!.content).toContain("Velvex Ops-Health");
  });

  it("covers the gap it is catching up on, not just the last 12 hours", async () => {
    // The check that happened during the silence is the one most worth seeing.
    const { ctx } = ctxWith({
      now: "2026-09-16T06:00:00Z",
      lastSent: "2026-09-15T17",
      reports: [
        { created_at: "2026-09-15T18:00:00Z", summary: "Operations status endpoint returned 500", detail: { active: true } },
        { created_at: "2026-09-16T05:00:00Z", summary: "healthy", detail: { concerning: false } },
      ],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.text).toContain("Operations status endpoint returned 500");
    expect(sent[0]!.subject).toMatch(/13h/); // reported honestly, not as "12h"
  });

  it("tells the owner in the email why the previous digest never arrived", async () => {
    const { ctx } = ctxWith({
      now: "2026-09-16T06:00:00Z",
      lastSent: "2026-09-15T17",
      lastError: { at: "2026-09-16T05:00:30Z", error: "SMTP connect timed out after 15000ms" },
      reports: [],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.text).toContain("never went out");
    expect(sent[0]!.html).toContain("SMTP connect timed out");
  });

  it("goes quiet about a failure a later send already superseded", async () => {
    const { ctx } = ctxWith({
      now: "2026-09-16T17:00:00Z",
      lastSent: "2026-09-16T06",
      lastError: { at: "2026-09-16T05:00:30Z", error: "connection refused" },
      reports: [],
    });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.text).not.toContain("never went out");
  });

  it("retries a refused connection within the same tick", async () => {
    failConnectTimes = 1;
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(connectAttempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sentKey(writes)).toHaveLength(1);
  });

  it("does NOT retry a send that already reached Gmail", async () => {
    // A retry past the connect is how this repo put 131 copies of one post in
    // the LinkedIn partner queue. One missed digest beats two identical ones.
    failSend = true;
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(connectAttempts).toBe(1);
    expect(sent).toHaveLength(0);
    expect(sentKey(writes)).toHaveLength(0);
    expect(errorKey(writes)[0]!.content).toContain("550 message rejected");
    expect(closed).toBe(1); // hung up even though the send threw
  });

  it("records why a digest failed instead of losing it to a discarded log array", async () => {
    failConnectTimes = 99;
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await expect(maybeSendOpsDigest(ctx)).resolves.not.toThrow();
    const err = errorKey(writes);
    expect(err).toHaveLength(1);
    expect(err[0]!.content).toContain("connection refused");
    expect(err[0]!.salience).toBe(2); // below the broadcast floor, like the sent row
  });

  it("gives every digest a distinct subject, so Gmail cannot thread a week into one", async () => {
    // Gmail threads on subject. A byte-identical subject every twelve hours
    // collapses the whole series into one conversation, which from the owner's
    // side is indistinguishable from the digest only ever having sent once.
    const first = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(first.ctx);
    const second = ctxWith({ now: "2026-09-16T17:00:00Z", lastSent: "2026-09-16T05", reports: [] });
    await maybeSendOpsDigest(second.ctx);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).not.toBe(sent[1]!.subject);
    expect(sent[1]!.subject).toContain("2026-09-16 17:00 UTC");
  });

  it("does not call a delivered digest unsent when only the bookkeeping failed", async () => {
    // The email is already out. Filing it as "never went out" would put a
    // false line in the NEXT email, and the record is not allowed to revise
    // what actually happened.
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    let attempts = 0;
    (ctx.db as unknown as { writeMemory: (row: MemoryWrite) => Promise<void> }).writeMemory =
      async (row: MemoryWrite) => {
        attempts += 1;
        writes.push(row);
        throw new Error("504 Gateway Timeout");
      };
    await expect(maybeSendOpsDigest(ctx)).resolves.not.toThrow();
    expect(sent).toHaveLength(1);
    expect(attempts).toBe(2); // retried, because losing it costs a duplicate email
    expect(errorKey(writes)).toHaveLength(0);
  });

  it("delivers to OPS_DIGEST_TO when set, while still sending as the authenticated account", async () => {
    // Self-addressed mail is the hardest kind to diagnose: sender and recipient
    // being one mailbox means "Gmail accepted it" and "it is in the inbox"
    // cannot be separated from outside.
    const { ctx } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [], to: "elsewhere@example.com" });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.to).toBe("elsewhere@example.com");
    expect((sent[0] as unknown as { from: { email: string } }).from.email).toBe("adam@velvexbi.com");
  });

  it("falls back to the sending account when no separate recipient is configured", async () => {
    const { ctx } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(sent[0]!.to).toBe("adam@velvexbi.com");
  });

  it("bounds a hanging SMTP socket rather than burning the rest of the tick", async () => {
    vi.useFakeTimers();
    try {
      hangConnect = true;
      const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
      const run = maybeSendOpsDigest(ctx);
      await vi.advanceTimersByTimeAsync(40_000); // past both bounded attempts
      await run;
      expect(sent).toHaveLength(0);
      expect(sentKey(writes)).toHaveLength(0);
      expect(errorKey(writes)[0]!.content).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
