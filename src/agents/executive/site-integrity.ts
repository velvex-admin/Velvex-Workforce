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
  checkStoredSource,
  compareWithServed,
  type IntegrityFinding,
  type ServedPage,
  type StoredPage,
} from "../../core/site-integrity.js";

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
  approvedChannels: ["internal"],

  routineRules: [
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
        action.type === "site_edit" || action.channel === "site"
          ? "This agent watches the site. Repairing it is a decision, and decisions are yours."
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

    if (findings.length === 0) {
      ctx.log("site_integrity: source and live site both intact");
      return [];
    }

    const critical = findings.filter((finding) => finding.severity === "critical");
    ctx.log(`site_integrity: ${critical.length} critical, ${findings.length - critical.length} warning(s)`);

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

  async execute(action: ProposedAction): Promise<ExecutionResult> {
    return { outcome: "observed", detail: action.payload };
  },
};
