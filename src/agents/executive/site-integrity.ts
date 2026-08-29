// Site-Integrity Agent — Executive.
//
//   Routine        monitoring and reporting
//   Needs approval anything that would change the site
//
// A smoke alarm for the one asset the agents can destroy. The SEO agent
// deploys whatever `site.source` holds, and a Netlify digest deploy is the
// whole site: a path missing from the manifest is removed. So the health of
// that table is the health of the site, one edit ahead.
//
// It watches our stored copy first and the live site second, because the
// failure that prompted it was invisible from outside — every page served
// perfectly while the source they would be overwritten from was two stubs.
//
// No model. Sizes against a floor, tags against a regex, served bytes against
// stored ones. Hourly, where a needless model call would add up fastest.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { STATE_KEYS, state } from "../../core/state.js";
import { BUSINESS } from "../../core/business.js";
import {
  assessDamage,
  checkStoredSource,
  compareWithServed,
  isPromotable,
  MAX_RESTORES_PER_DAY,
  restoresToday,
  type IntegrityFinding,
  type KnownGoodSource,
  type RestoreLedger,
  type ServedPage,
  type StoredPage,
} from "../../core/site-integrity.js";
import { deploySite } from "../../connectors/netlify.js";

/** Read every stored path from the live site, tolerating individual failures. */
async function fetchServed(paths: string[]): Promise<ServedPage[]> {
  const served: ServedPage[] = [];

  for (const path of paths) {
    try {
      const res = await fetch(`${BUSINESS.site}${path}`, { method: "GET" });
      const body = await res.text();
      served.push({ path, ok: res.ok, status: res.status, bytes: body.length });
    } catch {
      // A network error is not evidence the page is broken, so it is reported
      // as unreachable rather than silently dropped.
      served.push({ path, ok: false, status: 0, bytes: 0 });
    }
  }

  return served;
}

export const siteIntegrityAgent: AgentDefinition = {
  id: "site_integrity",
  name: "Site-Integrity Agent",
  batch: "executive",
  description:
    "Watches the stored site source and the live site for corruption and drift, so a bad deploy is caught before it is published rather than after.",
  model: null,
  effort: "medium",
  cadence: "hourly",
  observeOnly: true,
  // "site" is here so a restore can execute, and it is worth being clear what
  // that does and does not grant. The general boundary vetoes any channel
  // outside this set, so without it a restore queues and waits for a person —
  // which is the delay this feature exists to remove. It does NOT open the
  // site up to this agent: the rule below still refuses any site_edit, so the
  // only thing it may put on the channel is bytes that were already verified.
  approvedChannels: ["internal", "site"],

  routineRules: [
    {
      id: "site_integrity.restore_known_good",
      describe: "Putting the site back to the last copy that was verified sound.",
      classification: "routine",
      test: (action) =>
        action.type === "site_restore"
          ? "Restoring a verified copy is not authorship. Waiting for a person to approve it is " +
            "exactly the delay that lets a ruined site stay ruined overnight."
          : null,
    },
    {
      id: "site_integrity.monitor_and_report",
      describe: "Monitoring and reporting.",
      classification: "routine",
      test: (action) =>
        action.type === "observation" || action.type === "memory_write"
          ? "Monitoring and reporting is this agent's routine scope."
          : null,
    },
  ],

  approvalRules: [
    {
      id: "site_integrity.never_edits",
      describe: "Any change to the site or its stored source.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.type === "site_edit" || (action.channel === "site" && action.type !== "site_restore")
          ? "This agent watches the site. Writing something NEW to it is a decision, and " +
            "decisions are yours. Putting back a copy that was already verified is not."
          : null,
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    const source = await state.read<Record<string, string>>(ctx.db, STATE_KEYS.siteSource);

    if (!source || Object.keys(source).length === 0) {
      return [
        {
          type: "observation",
          summary: "Site-Integrity has nothing to watch: no site source is loaded",
          payload: {
            note: "Seed it by PUTting the deployed folder to /api/state/site.source.",
            active: false,
          },
          dedupeKey: `siteint:no-source:${ctx.now.toISOString().slice(0, 10)}`,
        },
      ];
    }

    const pages: StoredPage[] = Object.entries(source).map(([path, content]) => ({
      path,
      content: String(content ?? ""),
    }));

    // The stored source is checked on its own first: it is the copy that gets
    // deployed, and it can be corrupt while every live page looks perfect.
    const findings: IntegrityFinding[] = checkStoredSource(pages);
    ctx.log(`site_integrity: ${pages.length} stored paths, ${findings.length} problem(s) in the source itself`);

    const served = await fetchServed(pages.map((page) => page.path));
    findings.push(...compareWithServed(pages, served));

    // --- the known-good copy, and whether to go back to it ----------------
    const knownGood = await state.read<KnownGoodSource>(ctx.db, STATE_KEYS.siteLastGood);
    const ledger = await state.read<RestoreLedger>(ctx.db, STATE_KEYS.siteRestores);
    const damage = assessDamage(pages, served, knownGood ?? null);

    if (damage.ruined) {
      const already = restoresToday(ledger ?? null, ctx.now);
      if (already >= MAX_RESTORES_PER_DAY) {
        // Restoring again would not be a rescue, it would be a loop. Something
        // is putting the site back into this state faster than we can undo it,
        // and that is a person's problem now.
        ctx.log(
          `site_integrity: site is damaged but ${already} restore(s) already ran today; not acting`
        );
        return [
          {
            type: "observation",
            summary: "Site is damaged and automatic restore has stopped trying",
            payload: {
              problem: true,
              reasons: damage.reasons,
              restoresToday: already,
              note:
                "Two automatic restores have already run today and the damage came back. " +
                "Something is re-breaking the site faster than it can be put back, so this " +
                "needs a person before anything else is deployed.",
            },
            rationale: damage.reasons.join(" "),
            dedupeKey: `siteint:restore-exhausted:${ctx.now.toISOString().slice(0, 10)}`,
          },
        ];
      }

      ctx.log(`site_integrity: site is damaged, restoring the last verified copy — ${damage.reasons[0]}`);
      return [
        {
          type: "site_restore",
          summary: `Restoring the site to the copy verified on ${knownGood?.savedAt ?? "an earlier run"}`,
          channel: "site",
          payload: {
            reasons: damage.reasons,
            savedAt: knownGood?.savedAt,
            paths: Object.keys(knownGood?.files ?? {}),
            files: knownGood?.files ?? {},
          },
          rationale:
            `The site is damaged, not merely different: ${damage.reasons.join(" ")} ` +
            `Putting back the copy verified on ${knownGood?.savedAt} restores a state that was ` +
            `already checked, which is why this does not wait for approval.`,
          dedupeKey: `siteint:restore:${ctx.now.toISOString().slice(0, 13)}`,
        },
      ];
    }

    const criticalNow = findings.filter((finding) => finding.severity === "critical");

    // Sound enough to be worth going back to. Deliberately keyed on CRITICAL
    // findings rather than on a clean bill of health: a warning-level drift is
    // normal — Netlify injects several hundred bytes of its own into every
    // served page — and requiring zero findings would leave the restore point
    // permanently unarmed, which is a safety net that exists only on paper.
    if (criticalNow.length === 0 && isPromotable(pages)) {
      await state.write(
        ctx.db,
        STATE_KEYS.siteLastGood,
        { savedAt: ctx.now.toISOString(), files: source } satisfies KnownGoodSource,
        `${pages.length} verified site files kept as the restore point`,
        { scope: "site", agent: "site_integrity", salience: 4, tags: ["site"] }
      );
      ctx.log(`site_integrity: restore point updated (${pages.length} files)`);
    }

    if (findings.length === 0) {
      ctx.log("site_integrity: source and live site both intact");
      return [];
    }

    ctx.log(
      `site_integrity: ${criticalNow.length} critical, ${findings.length - criticalNow.length} warning(s)`
    );

    // One observation per finding, so each names a single path and a single
    // problem rather than arriving as a digest nobody reads to the end of.
    return findings.map((finding) => ({
      type: "observation" as const,
      summary:
        finding.severity === "critical"
          ? `Site integrity: ${finding.path} — ${finding.kind.replace(/_/g, " ")}`
          : `Site drift: ${finding.path}`,
      payload: {
        problem: finding.severity === "critical",
        kind: finding.kind,
        path: finding.path,
        detail: finding.detail,
        severity: finding.severity,
      },
      rationale: finding.detail,
      // Same path and same fault should not re-queue every hour; a new day is
      // a new reminder if it is still unfixed.
      dedupeKey: `siteint:${finding.kind}:${finding.path}:${ctx.now.toISOString().slice(0, 10)}`,
    }));
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type !== "site_restore") {
      return { outcome: "observed", detail: action.payload };
    }

    const files = (action.payload["files"] ?? {}) as Record<string, string>;
    if (Object.keys(files).length === 0) {
      return { outcome: "failed", detail: { error: "Nothing to restore: the copy was empty." } };
    }

    // The stored source goes back FIRST. It is what the SEO agent deploys from,
    // so leaving it damaged would mean the next SEO run re-publishes the very
    // thing this is undoing.
    await state.write(
      ctx.db,
      STATE_KEYS.siteSource,
      files,
      `site source restored from the copy verified on ${action.payload["savedAt"]}`,
      { scope: "site", agent: "site_integrity", salience: 7, tags: ["site"] }
    );

    const deployId = await deploySite(ctx.env, files);

    const ledger = (await state.read<RestoreLedger>(ctx.db, STATE_KEYS.siteRestores)) ?? { at: [] };
    await state.write(
      ctx.db,
      STATE_KEYS.siteRestores,
      { at: [...ledger.at, new Date().toISOString()].slice(-20) } satisfies RestoreLedger,
      "automatic site restore recorded",
      { scope: "site", agent: "site_integrity", salience: 4, tags: ["site"] }
    );

    return {
      outcome: "executed",
      detail: {
        deployId,
        restoredPaths: Object.keys(files).length,
        savedAt: action.payload["savedAt"],
        reasons: action.payload["reasons"],
      },
    };
  },
};
