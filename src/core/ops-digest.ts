// Twice-daily Ops-Health email digest.
//
// The owner wants to know the pipeline's health without opening the
// dashboard: one message every 12 hours, whether or not anything went
// wrong, so silence is never the only signal. This piggybacks on the
// existing HOURLY_MAIN cron tick rather than asking for a sixth cron
// trigger — the account does not have one to give (see CLAUDE.md section
// 9) — so this runs on every hourly tick and is a no-op on ten of every
// twelve of them.

import { WorkerMailer } from "worker-mailer";
import type { RunContext } from "./agent.js";
import { state } from "./state.js";

// 05:00 and 17:00 UTC = 08:00 and 20:00 in Amman (UTC+3, no DST) — a morning
// and evening check-in, not a midnight one. Change these two numbers if the
// owner wants a different pair of times; nothing else needs to move.
const DIGEST_HOURS_UTC = [5, 17];
const DIGEST_WINDOW_HOURS = 12;
const DIGEST_LAST_SENT_KEY = "ops.digest.last_sent";

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

/** One id per calendar hour, so a re-run within the same hour cannot double-send. */
function slotId(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T${String(now.getUTCHours()).padStart(2, "0")}`;
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
 *   anything.
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
}): { subject: string; text: string; html: string } {
  const { windowReports, issues, since, now } = opts;
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
  } (12h)`;

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
  const hour = ctx.now.getUTCHours();
  if (!DIGEST_HOURS_UTC.includes(hour)) return;

  const slot = slotId(ctx.now);
  const lastSent = await state.read<string>(ctx.db, DIGEST_LAST_SENT_KEY);
  if (lastSent === slot) return;

  const since = new Date(ctx.now.getTime() - DIGEST_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = await ctx.db.listReports({ agentId: "ops_health", limit: 40 });
  const windowReports = recent.filter((r) => r.created_at && new Date(r.created_at) >= since);
  const issues = windowReports.filter(isIssue);

  const { subject, text, html } = buildDigestEmail({ windowReports, issues, since, now: ctx.now });

  try {
    await deliverDigest(ctx.env, { subject, text, html });
    await state.write(ctx.db, DIGEST_LAST_SENT_KEY, slot, `sent: ${subject}`, {
      scope: "ops_health",
      agent: "ops_health",
      // Below the minSalience:6 floor the two broadcast readers use — this is
      // bookkeeping for this function, not something any other agent's prompt
      // should ever see. See CLAUDE.md's retrieval-contract note.
      salience: 2,
      tags: ["ops", "digest"],
    });
    ctx.log(`ops digest sent: ${subject}`);
  } catch (err) {
    // Best-effort. A missed digest is not worth failing the whole hourly tick
    // over, and the next chance is the next digest hour twelve hours out —
    // there is no separate retry path, deliberately, to keep this small.
    // (Also the outcome when OPS_DIGEST_GMAIL_USER/APP_PASSWORD aren't set:
    // deliverDigest's own error says so.)
    ctx.log(`ops digest send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deliverDigest(
  env: RunContext["env"],
  email: { subject: string; text: string; html: string }
): Promise<void> {
  const user = env.OPS_DIGEST_GMAIL_USER;
  const pass = env.OPS_DIGEST_GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("OPS_DIGEST_GMAIL_USER/OPS_DIGEST_GMAIL_APP_PASSWORD not set");
  }

  const mailer = await WorkerMailer.connect({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    startTls: true,
    credentials: { username: user, password: pass },
    authType: "plain",
  });
  try {
    await mailer.send({ from: { name: "Velvex Ops-Health", email: user }, to: user, ...email });
  } finally {
    await mailer.close();
  }
}
