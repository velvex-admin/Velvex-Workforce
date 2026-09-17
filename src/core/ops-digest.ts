// Twice-daily Ops-Health email digest.
//
// The owner wants to know the pipeline's health without opening the
// dashboard: one message every 12 hours, whether or not anything went
// wrong, so silence is never the only signal. This piggybacks on the
// existing HOURLY_MAIN cron tick rather than asking for a sixth cron
// trigger — the account does not have one to give (see CLAUDE.md section
// 9) — so this runs on every hourly tick and sends on two of them.
//
// It reads one row on each of the other ticks, which it did not used to. That
// is the price of the catch-up rule, and the catch-up rule is why this file
// was revisited: shipped 2026-09-15, it had four scheduled slots by 09-17 and
// delivered one email. The cron tick fired at all four. Nothing retried,
// nothing caught up, and the reason for each miss went to ctx.log — which on a
// cron run is an array the handler collects and never prints.

import { WorkerMailer } from "worker-mailer";
import type { RunContext } from "./agent.js";
import { state } from "./state.js";

// 05:00 and 17:00 UTC = 08:00 and 20:00 in Amman (UTC+3, no DST) — a morning
// and evening check-in, not a midnight one. Change these two numbers if the
// owner wants a different pair of times; nothing else needs to move.
const DIGEST_HOURS_UTC = [5, 17];
const DIGEST_WINDOW_HOURS = 12;
const DIGEST_LAST_SENT_KEY = "ops.digest.last_sent";
const DIGEST_LAST_ERROR_KEY = "ops.digest.last_error";

// A missed digest hour used to cost a full half-day of silence. The hour check
// was exact, the slot id is hour-granular, and there was no retry and no
// catch-up — so one transient failure at 05:00 meant the next email was at
// 17:00, and nothing said why. Measured 2026-09-17: the cron tick fired at all
// four digest hours between 09-15 17:00 and 09-17 05:00, and exactly one of
// them produced an email.
//
// A digest is therefore also due whenever the last successful one is older
// than this, on ANY hourly tick. Thirteen is the twelve-hour cadence plus one
// tick of grace, so a missed 05:00 goes out at 06:00 instead of at 17:00, and
// the next digest hour re-anchors the rhythm on its own.
const OVERDUE_HOURS = 13;

// Bounds the catch-up. Without it, the first digest after a long outage would
// reach back to the last success and put days of check lines in one email.
const MAX_WINDOW_HOURS = 36;

// ops_health runs hourly, so this has to cover MAX_WINDOW_HOURS of them with
// room to spare — a limit below the window silently truncates the log rather
// than reporting less time.
const REPORT_LOOKBACK = 60;

// Sent from and to the same Gmail/Workspace mailbox — a self-addressed ops
// alert, same shape as any cron-job email-to-self. Over Gmail SMTP rather
// than Cloudflare Email Service: see wrangler.toml's header comment for why
// (Workers Paid gate, and the free workaround would have hijacked
// velvexbi.com's real MX). Requires OPS_DIGEST_GMAIL_USER and
// OPS_DIGEST_GMAIL_APP_PASSWORD as secrets — a Gmail App Password, not the
// account login password (Google rejects the latter outright over SMTP,
// same lesson already hit once in this project's Phase 0 build).
const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 587;

// Every other outbound call in this system is bounded (CLAUDE.md section 10
// records the same trap three times: a fetch with no signal is not a slow call,
// it is a call that may never return). This one opens a raw TCP socket at the
// very end of a cron invocation, so a hang here burns the rest of the tick's
// wall clock and the digest dies with nothing written.
const SMTP_CONNECT_TIMEOUT_MS = 15_000;
const SMTP_SEND_TIMEOUT_MS = 20_000;

// Connect is retried; send is NOT. See deliverDigest.
const SMTP_CONNECT_ATTEMPTS = 2;

/** One id per calendar hour, so a re-run within the same hour cannot double-send. */
function slotId(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T${String(now.getUTCHours()).padStart(2, "0")}`;
}

/**
 * A stored slot id parsed back to the instant it names, or null if there is
 * nothing usable there. Null is the honest answer for both "never sent" and
 * "stored value we cannot read": neither one licenses a catch-up.
 */
function slotTime(slot: string | null): number | null {
  if (!slot) return null;
  const ms = Date.parse(`${slot}:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

export type DueReason = "slot" | "overdue";

/**
 * Whether a digest is due, and which rule says so. Pure and exported because
 * the half that failed in production is the SCHEDULE, not the HTML — and a
 * schedule that can only be exercised through a mailer is a schedule nobody
 * tests.
 *
 * Note the order. The already-sent check comes first, so neither rule can
 * double-send within an hour; then the ordinary digest hour; then the
 * catch-up. A key that was never written does NOT trigger a catch-up — on a
 * fresh deploy the first email should land on a real digest hour rather than
 * on whatever tick happened to follow.
 */
export function digestDue(now: Date, lastSent: string | null): DueReason | null {
  if (lastSent === slotId(now)) return null;
  if (DIGEST_HOURS_UTC.includes(now.getUTCHours())) return "slot";

  const sentAt = slotTime(lastSent);
  if (sentAt === null) return null;
  return now.getTime() - sentAt >= OVERDUE_HOURS * 3_600_000 ? "overdue" : null;
}

/**
 * Where the reported window starts. A catch-up covers the gap it is catching
 * up on: reporting only the last twelve hours after a missed digest would drop
 * the checks from the period nobody heard about, which is the period most
 * worth hearing about.
 */
function windowStart(now: Date, lastSent: string | null): Date {
  const standard = now.getTime() - DIGEST_WINDOW_HOURS * 3_600_000;
  const sentAt = slotTime(lastSent);
  if (sentAt === null || sentAt >= standard) return new Date(standard);
  return new Date(Math.max(sentAt, now.getTime() - MAX_WINDOW_HOURS * 3_600_000));
}

/**
 * A line for the email when the PREVIOUS attempt failed, so the first digest
 * to arrive after a gap says what the gap was. Nothing clears the error row:
 * it is superseded rather than deleted, because a successful send writes a
 * newer timestamp to the sent row and this comparison then goes quiet on its
 * own — which is one subrequest cheaper than clearing it every time.
 */
function previousFailure(raw: unknown, lastSent: string | null): string | null {
  if (!raw || typeof raw !== "object") return null;
  const at = (raw as Record<string, unknown>)["at"];
  const error = (raw as Record<string, unknown>)["error"];
  if (typeof at !== "string" || typeof error !== "string") return null;

  const failedAt = Date.parse(at);
  if (Number.isNaN(failedAt)) return null;

  const sentAt = slotTime(lastSent);
  if (sentAt !== null && failedAt <= sentAt) return null;

  return `The previous digest (${formatTime(at)}) never went out: ${error}`;
}

/**
 * Whether a stored Ops-Health report describes a real problem, as opposed to
 * the two non-problem shapes its own code produces: a healthy read
 * (`concerning: false`) and the "not connected yet" placeholder
 * (`active: false`). See src/agents/executive/ops-health.ts's propose() —
 * every error path (bad status, non-JSON body, timeout, unreachable) sets
 * `active: true` and nothing else does.
 */
function isIssue(report: { outcome?: string; detail?: Record<string, unknown> }): boolean {
  if (report.outcome === "failed") return true;
  const detail = report.detail ?? {};
  if (detail["active"] === true) return true;
  if (detail["concerning"] === true) return true;
  return false;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "unknown time";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

type Status = "clear" | "issues" | "no_data";

function statusOf(windowReports: unknown[], issueCount: number): Status {
  if (windowReports.length === 0) return "no_data";
  if (issueCount > 0) return "issues";
  return "clear";
}

const STATUS_STYLE: Record<Status, { icon: string; bg: string; fg: string; border: string }> = {
  clear: { icon: "✓", bg: "#eaf7f0", fg: "#1e7d4f", border: "#bfe3cf" },
  issues: { icon: "⚠", bg: "#fdecec", fg: "#b03030", border: "#f3c6c6" },
  no_data: { icon: "⚠", bg: "#fff8e6", fg: "#8a6d1a", border: "#f0dfa8" },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Composes the email. The one thing this has to get right — the owner's own
 * bar, set after the first version shipped — is readable in the first five
 * seconds, before scrolling. Three choices toward that:
 * - The subject leads with an icon and the verdict, not "Velvex Ops-Health":
 *   a phone notification truncates long before the sender name would say
 *   anything. It ENDS with the timestamp, which is not decoration: Gmail
 *   threads on subject, and a byte-identical subject every twelve hours
 *   collapses a week of digests into one conversation that reads as a single
 *   email. That is a second, independent way this feature can look like it
 *   only ever sent one — and it is indistinguishable from the sends failing,
 *   from the owner's side. The tail is what gets truncated on a phone, so the
 *   verdict is not paid for.
 * - The HTML puts one big colour-coded banner right under the header, with
 *   nothing above it worth reading first — no logo story, no preamble.
 * - Issues, if any, are pulled into their own callout ahead of the full log,
 *   so triage never requires reading every line to find the one that matters.
 */
function buildDigestEmail(opts: {
  windowReports: Array<{ created_at?: string; summary: string; outcome?: string; detail?: Record<string, unknown> }>;
  issues: Array<{ created_at?: string; summary: string }>;
  since: Date;
  now: Date;
  previousFailure?: string | null;
}): { subject: string; text: string; html: string } {
  const { windowReports, issues, since, now } = opts;
  const missedNotice = opts.previousFailure ?? null;

  // Reported rather than hard-coded, because a catch-up digest covers the gap
  // it is catching up on — an email headed "(12h)" that actually reports
  // twenty-six of them is the kind of small lie that costs trust in the rest.
  const windowHours = Math.max(1, Math.round((now.getTime() - since.getTime()) / 3_600_000));
  const status = statusOf(windowReports, issues.length);
  const style = STATUS_STYLE[status];

  const headline =
    status === "no_data"
      ? "NO MONITORING DATA"
      : status === "issues"
        ? `${issues.length} ISSUE${issues.length === 1 ? "" : "S"} FOUND`
        : "ALL CLEAR";

  const lede =
    status === "no_data"
      ? "Ops-Health did not record a single check in this window. Either it's paused, or something is stopping it from running at all — worth a look at the dashboard."
      : status === "issues"
        ? `${issues.length} of ${windowReports.length} checks in this window flagged something.`
        : `All ${windowReports.length} checks in this window came back healthy.`;

  const subject = `${style.icon === "✓" ? "✅" : "⚠️"} Velvex Ops-Health — ${
    status === "no_data" ? "no data" : status === "issues" ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "all clear"
  } (${windowHours}h) \u00b7 ${formatTime(now.toISOString())}`;

  const windowLabel = `${formatTime(since.toISOString())} – ${formatTime(now.toISOString())}`;

  const orderedLines = windowReports
    .slice()
    .reverse()
    .map((r) => ({ time: formatTime(r.created_at), summary: r.summary, issue: isIssue(r) }));

  // --- text ---
  const textParts = [
    `[${headline}]`,
    lede,
    "",
    `Window: ${windowLabel}`,
  ];
  if (missedNotice) textParts.push("", `! ${missedNotice}`);
  if (issues.length) {
    textParts.push("", "ISSUES:");
    for (const i of issues) textParts.push(`  - ${formatTime(i.created_at)} — ${i.summary}`);
  }
  if (orderedLines.length) {
    textParts.push("", "Full log:");
    for (const l of orderedLines) textParts.push(`  ${l.issue ? "[ISSUE] " : ""}${l.time} — ${l.summary}`);
  }
  textParts.push("", "— Velvex Ops-Health, automatic, every 12 hours");
  const text = textParts.join("\n");

  // --- html ---
  const issuesBlock = issues.length
    ? `<tr><td style="padding:0 32px 8px;">
         <div style="border:1px solid ${STATUS_STYLE.issues.border};background:${STATUS_STYLE.issues.bg};border-radius:6px;padding:12px 16px;margin-bottom:20px;">
           <div style="font-size:12px;font-weight:bold;color:${STATUS_STYLE.issues.fg};text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">What needs a look</div>
           ${issues
             .map(
               (i) =>
                 `<div style="font-size:13px;color:${STATUS_STYLE.issues.fg};line-height:1.6;"><b>${escapeHtml(formatTime(i.created_at))}</b> — ${escapeHtml(i.summary)}</div>`
             )
             .join("")}
         </div>
       </td></tr>`
    : "";

  const missedBlock = missedNotice
    ? `<tr><td style="padding:12px 32px 0;">
         <div style="border:1px solid ${STATUS_STYLE.no_data.border};background:${STATUS_STYLE.no_data.bg};border-radius:6px;padding:10px 14px;font-size:12px;color:${STATUS_STYLE.no_data.fg};line-height:1.5;">
           ${escapeHtml(missedNotice)}
         </div>
       </td></tr>`
    : "";

  const logRows = orderedLines
    .map(
      (l) =>
        `<tr>
           <td style="padding:4px 8px 4px 0;font-size:11px;color:#9199a3;white-space:nowrap;vertical-align:top;">${escapeHtml(l.time)}</td>
           <td style="padding:4px 0;font-size:12px;color:${l.issue ? "#b03030" : "#5c6170"};font-weight:${l.issue ? "bold" : "normal"};">${escapeHtml(l.summary)}</td>
         </tr>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3e5e8;border-radius:8px;overflow:hidden;">
  <tr><td style="background:#1a3a5c;padding:16px 32px;">
    <span style="color:#c9a84c;font-size:10px;letter-spacing:1.5px;font-weight:bold;text-transform:uppercase;">VELVEX · OPS-HEALTH</span>
  </td></tr>
  <tr><td style="background:${style.bg};border-bottom:1px solid ${style.border};padding:24px 32px;">
    <div style="font-size:26px;line-height:1;margin-bottom:8px;">${style.icon} <span style="font-size:20px;font-weight:bold;color:${style.fg};letter-spacing:.02em;vertical-align:2px;">${escapeHtml(headline)}</span></div>
    <div style="font-size:14px;color:${style.fg};line-height:1.5;">${escapeHtml(lede)}</div>
  </td></tr>
  <tr><td style="padding:16px 32px 0;">
    <div style="font-size:11px;color:#9199a3;">Window: ${escapeHtml(windowLabel)}</div>
  </td></tr>
  ${missedBlock}
  ${issuesBlock}
  <tr><td style="padding:8px 32px 24px;">
    <div style="font-size:11px;font-weight:bold;color:#9199a3;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 6px;">Full check log (${orderedLines.length})</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${logRows}</table>
  </td></tr>
  <tr><td style="padding:16px 32px;border-top:1px solid #eceef1;font-size:11px;color:#8a8f98;">
    Automatic — every 12 hours, no action needed unless something's flagged above.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

export async function maybeSendOpsDigest(ctx: RunContext): Promise<void> {
  // One read, on every hourly tick. This used to cost nothing on ten ticks in
  // twelve, because the hour was checked before anything was read — but that
  // same check is what made a single missed send cost twelve hours of silence,
  // and the overdue rule cannot be evaluated without knowing when the last one
  // went out. One GET, against an invocation budget of roughly fifty, on a tick
  // that runs two agents, is what the catch-up costs. Both keys come back in
  // the same request, so a send hour still makes exactly the two reads it made
  // before.
  const stored = await state.readMany(ctx.db, [DIGEST_LAST_SENT_KEY, DIGEST_LAST_ERROR_KEY]);
  const rawLastSent = stored.get(DIGEST_LAST_SENT_KEY);
  const lastSent = typeof rawLastSent === "string" ? rawLastSent : null;

  const due = digestDue(ctx.now, lastSent);
  if (!due) return;

  // ctx.log writes into an array that the cron handler collects and never
  // prints, so on a scheduled run it is not a log at all. Three digests were
  // lost between 2026-09-15 and 09-17 and the reason for every one of them was
  // written to that array and dropped. console goes to the Worker's own log
  // stream, which outlives the invocation and is what `wrangler tail` shows.
  const note = (line: string) => {
    ctx.log(line);
    console.log(`vx03 ops-digest: ${line}`);
  };

  const since = windowStart(ctx.now, lastSent);
  const recent = await ctx.db.listReports({ agentId: "ops_health", limit: REPORT_LOOKBACK });
  const windowReports = recent.filter((r) => r.created_at && new Date(r.created_at) >= since);
  const issues = windowReports.filter(isIssue);

  const { subject, text, html } = buildDigestEmail({
    windowReports,
    issues,
    since,
    now: ctx.now,
    previousFailure: previousFailure(stored.get(DIGEST_LAST_ERROR_KEY), lastSent),
  });

  let delivered = false;
  try {
    await deliverDigest(ctx.env, { subject, text, html }, note);
    delivered = true;
    await markSent(ctx, subject);
    note(`sent on the ${due} rule: ${subject}`);
  } catch (err) {
    // Still best-effort — a missed digest must not fail the hourly tick — but
    // no longer silent. The reason is recorded in three places that outlive the
    // invocation: the Worker log, a memory row anyone can read without a
    // deploy, and the next digest to actually arrive.
    const message = err instanceof Error ? err.message : String(err);

    if (delivered) {
      // The email is out; only the record of it failed. Saying "never went
      // out" here would be the bookkeeping revising what actually happened,
      // which is a mistake this repo has made once already on the report path.
      // The honest consequence: the next tick reads a stale last-sent and the
      // overdue rule may send a second copy. That is the right way round for
      // this feature — a duplicate is visible, and silence is what the owner
      // asked us to fix.
      ctx.log(`ops digest delivered, but recording it failed: ${message}`);
      console.error(`vx03 ops-digest: delivered, but recording it failed: ${message}`);
      return;
    }

    ctx.log(`ops digest send failed: ${message}`);
    console.error(`vx03 ops-digest: send failed: ${message}`);
    await recordFailure(ctx, message);
  }
}

/**
 * Records the send. Attempted twice because the cost of losing this write is a
 * duplicate email on the next tick — the row is an upsert on its key, so a
 * second attempt lands on the same row rather than creating another.
 */
async function markSent(ctx: RunContext, subject: string): Promise<void> {
  const write = () =>
    state.write(ctx.db, DIGEST_LAST_SENT_KEY, slotId(ctx.now), `sent: ${subject}`, {
      scope: "ops_health",
      agent: "ops_health",
      // Below the minSalience:6 floor the two broadcast readers use — this is
      // bookkeeping for this function, not something any other agent's prompt
      // should ever see. See CLAUDE.md's retrieval-contract note.
      salience: 2,
      tags: ["ops", "digest"],
    });

  try {
    await write();
  } catch {
    await write();
  }
}

/**
 * Writes why a digest did not go out, so the next twelve hours of silence have
 * an explanation attached to them. Swallows its own failure for the reason
 * writeStatus() does: a bookkeeping write must never be the thing that takes
 * the tick down.
 */
async function recordFailure(ctx: RunContext, message: string): Promise<void> {
  try {
    await state.write(
      ctx.db,
      DIGEST_LAST_ERROR_KEY,
      { at: ctx.now.toISOString(), slot: slotId(ctx.now), error: message },
      `digest failed: ${message}`,
      { scope: "ops_health", agent: "ops_health", salience: 2, tags: ["ops", "digest"] }
    );
  } catch {
    // Nothing left to do about it here; the console line above already went out.
  }
}

/**
 * Bounds a promise that has no cancellation of its own. The abandoned promise
 * gets a no-op catch attached because once the race is lost nobody is awaiting
 * it, and an unhandled rejection is a second failure on top of the first; the
 * timer is always cleared, because a pending timer can hold a Worker
 * invocation open after the work is done.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deliverDigest(
  env: RunContext["env"],
  email: { subject: string; text: string; html: string },
  note: (line: string) => void
): Promise<void> {
  const user = env.OPS_DIGEST_GMAIL_USER;
  const pass = env.OPS_DIGEST_GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("OPS_DIGEST_GMAIL_USER/OPS_DIGEST_GMAIL_APP_PASSWORD not set");
  }

  // FROM must remain the authenticated account; only the destination moves.
  const recipient = env.OPS_DIGEST_TO?.trim() || user;

  // Connect is the retryable half: nothing has been handed to Gmail yet, so a
  // second attempt cannot produce a second email. A refused or dropped TCP
  // connection is also the most likely transient failure here, and the one
  // that previously cost a whole twelve-hour cycle.
  let mailer: Awaited<ReturnType<typeof WorkerMailer.connect>> | null = null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= SMTP_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      mailer = await withTimeout(
        WorkerMailer.connect({
          host: SMTP_HOST,
          port: SMTP_PORT,
          secure: false,
          startTls: true,
          credentials: { username: user, password: pass },
          authType: "plain",
        }),
        SMTP_CONNECT_TIMEOUT_MS,
        "SMTP connect"
      );
      break;
    } catch (err) {
      lastError = err;
      note(`SMTP connect attempt ${attempt} of ${SMTP_CONNECT_ATTEMPTS} failed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
  }
  if (!mailer) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // The send itself is deliberately NOT retried. Past the connect, a failure
  // may have left a message Gmail already accepted, and re-sending something
  // that may have landed is how this repo put 131 copies of one post in the
  // LinkedIn partner queue. One missed digest beats two identical ones, and the
  // catch-up rule will carry the next one anyway.
  try {
    await withTimeout(
      mailer.send({ from: { name: "Velvex Ops-Health", email: user }, to: recipient, ...email }),
      SMTP_SEND_TIMEOUT_MS,
      "SMTP send"
    );
    // Recorded because "the Worker sent it" and "it arrived" are different
    // facts, and the first is worthless without knowing where it was aimed.
    note(`accepted by ${SMTP_HOST} for ${recipient}`);
  } finally {
    // The mail is already out by this point, so a failure to hang up politely
    // must not become the error the caller sees.
    await Promise.resolve(mailer.close()).catch(() => {});
  }
}
