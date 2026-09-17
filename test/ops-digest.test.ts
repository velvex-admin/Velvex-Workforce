// The digest piggybacks on the hourly cron tick rather than owning a cron
// line of its own (the account has none spare — see CLAUDE.md section 9), so
// the thing worth asserting is the gating: it must do nothing on ten of every
// twelve ticks, and nothing twice within the same digest hour.
//
// worker-mailer opens a real TCP socket via cloudflare:sockets, which vitest's
// default environment does not have, so it is mocked here rather than stubbed
// at the fetch layer the way ops-health.test.ts stubs a plain HTTP call.

import { describe, expect, it, vi } from "vitest";
import { maybeSendOpsDigest } from "../src/core/ops-digest.js";
import type { RunContext } from "../src/core/agent.js";

const sent: Array<{ to: unknown; subject: string; text: string; html: string }> = [];
let closed = 0;

// vi.mock calls are hoisted above imports by vitest, so this applies before
// ops-digest.ts's own `import { WorkerMailer } from "worker-mailer"` resolves.
vi.mock("worker-mailer", () => ({
  WorkerMailer: {
    async connect() {
      return {
        async send(msg: { to: unknown; subject: string; text: string; html: string }) {
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
  withCreds?: boolean;
}) {
  const writes: Array<{ key: string; content: string; salience?: number }> = [];
  const memoryRows = opts.lastSent
    ? [{ key: "ops.digest.last_sent", detail: { value: opts.lastSent } }]
    : [];

  const ctx = {
    env:
      opts.withCreds === false
        ? {}
        : { OPS_DIGEST_GMAIL_USER: "adam@velvexbi.com", OPS_DIGEST_GMAIL_APP_PASSWORD: "test-app-password" },
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
    sent.length = 0;
    const { ctx, writes } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [], withCreds: false });
    await expect(maybeSendOpsDigest(ctx)).resolves.not.toThrow();
    expect(sent).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("always closes the SMTP connection after sending", async () => {
    sent.length = 0;
    closed = 0;
    const { ctx } = ctxWith({ now: "2026-09-16T05:00:00Z", reports: [] });
    await maybeSendOpsDigest(ctx);
    expect(closed).toBe(1);
  });
});
