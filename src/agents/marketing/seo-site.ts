// SEO / Site Agent — Marketing. Write access.
//
// Architecture doc: can make changes directly rather than only suggesting them,
// but the routine line is drawn tighter than the publishing agents, since it
// edits the live site instead of posting something easily deleted.
//
//   Routine        meta descriptions, alt text, internal linking, on-page copy,
//                  structural SEO fixes
//   Needs approval pricing pages, legal/contract-adjacent pages, any full page
//                  restructure
//
// Both halves are enforced below. Note that the protected-page rule is checked
// before the edit-kind rule, so a meta description on /pricing is queued even
// though meta descriptions are otherwise routine — which is the tighter line
// the doc asks for.

import type { AgentDefinition, RunContext } from "../../core/agent.js";
import type { ExecutionResult, ProposedAction } from "../../core/types.js";
import { ROUTINE_SITE_EDITS, isProtectedPage, type SiteEditKind } from "../../core/config.js";
import { inventoryFromSource } from "../../core/site-inventory.js";
import { altTextEdit, metaDescriptionEdit } from "../../core/site-edits.js";
import { STATE_KEYS, state, type SitePage } from "../../core/state.js";
import { getSiteWriter } from "../../connectors/site.js";
import { DEFAULT_VOICE, scanForTells, softenTells } from "../../core/voice.js";

import { MODELS } from "../../core/models.js";
import { BUSINESS_CONTEXT } from "../../core/business.js";

const MODEL = MODELS.balanced;
const ALT_TEXT_MODEL = MODELS.fast;

/** Reached without a link from anywhere, so never an orphan. */
function isHomePage(path: string): boolean {
  return /^\/(index\.html?)?$/i.test(path);
}

const META_MIN = 70;
const META_MAX = 155;

interface Finding {
  page: SitePage;
  kind: SiteEditKind;
  problem: string;
  before: string;
}

/** Deterministic pass first: find what is actually wrong before asking the model to fix it. */
function findIssues(pages: SitePage[]): Finding[] {
  const findings: Finding[] = [];

  for (const page of pages) {
    const meta = page.metaDescription?.trim() ?? "";
    if (meta.length === 0) {
      findings.push({
        page,
        kind: "meta_description",
        problem: "no meta description",
        before: "",
      });
    } else if (meta.length < META_MIN || meta.length > META_MAX) {
      findings.push({
        page,
        kind: "meta_description",
        problem: `meta description is ${meta.length} characters, outside ${META_MIN}-${META_MAX}`,
        before: meta,
      });
    }

    for (const image of page.images ?? []) {
      if (!image.alt || image.alt.trim().length === 0) {
        findings.push({
          page,
          kind: "alt_text",
          problem: `image ${image.src} has no alt text`,
          before: image.src,
        });
      }
    }

    // A home page is reached without a link, so it is never an orphan. The
    // check exempted "/" only, while the source keys it "/index.html", so the
    // home page was reported as an orphan on every run.
    if ((page.inboundInternalLinks ?? 0) === 0 && !isHomePage(page.path)) {
      findings.push({
        page,
        kind: "internal_link",
        problem: "orphan page: nothing on the site links to it",
        before: page.path,
      });
    }
  }

  return findings;
}

const SYSTEM = `You write on-page SEO copy for the Velvex site.

${BUSINESS_CONTEXT}

${DEFAULT_VOICE.guide}

Extra rules for this job: write for a person deciding whether to click, not for a crawler. No keyword stuffing, no "discover", no "learn more about". Output only the replacement text, nothing else.`;

export const seoSiteAgent: AgentDefinition = {
  id: "seo_site",
  name: "SEO / Site Agent",
  batch: "marketing",
  description:
    "Edits the live site directly within a tighter routine line: on-page and structural SEO yes, pricing and legal pages no.",
  // Copy written inside tight, well-specified bounds: a meta description has a
  // length, a subject and a page to match. That is squarely balanced-tier work.
  model: MODEL,
  effort: "high",
  cadence: "daily",
  approvedChannels: ["site"],

  routineRules: [
    {
      id: "seo.routine_on_page_edit",
      describe: "Meta descriptions, alt text, internal linking, on-page copy, structural fixes.",
      classification: "routine",
      test: (action) => {
        if (action.type !== "site_edit") return null;
        const kind = action.payload["kind"];
        const path = String(action.payload["path"] ?? "");
        if (!(ROUTINE_SITE_EDITS as readonly string[]).includes(String(kind))) return null;
        if (isProtectedPage(path)) return null; // handled by the veto rule; belt and braces
        if (action.payload["fullRestructure"] === true) return null;
        return `"${String(kind)}" on ${path} is inside the routine on-page scope.`;
      },
    },
  ],

  approvalRules: [
    {
      id: "seo.protected_page",
      describe: "Pricing, legal and contract-adjacent pages, whatever the edit.",
      classification: "needs_approval",
      risk: "high",
      test: (action) => {
        const path = String(action.payload["path"] ?? action.target ?? "");
        return path && isProtectedPage(path)
          ? `${path} is a pricing or legal/contract-adjacent page, so every edit to it waits for you.`
          : null;
      },
    },
    {
      id: "seo.full_restructure",
      describe: "Any full page restructure.",
      classification: "needs_approval",
      risk: "high",
      test: (action) =>
        action.payload["fullRestructure"] === true
          ? "A full page restructure changes more than the copy on it."
          : null,
    },
    {
      id: "seo.unknown_edit_kind",
      describe: "An edit type outside the listed routine set.",
      classification: "needs_approval",
      risk: "medium",
      test: (action) => {
        if (action.type !== "site_edit") return null;
        const kind = String(action.payload["kind"] ?? "");
        return (ROUTINE_SITE_EDITS as readonly string[]).includes(kind)
          ? null
          : `"${kind}" is not one of the routine site edit types.`;
      },
    },
  ],

  async propose(ctx: RunContext): Promise<ProposedAction[]> {
    // Prefer the source we hold. Deriving the inventory from it keeps the paths
    // identical to the ones the writer edits — an inventory fetched separately
    // used "/faq" where the source key is "/faq.html", so every edit pointed at
    // a path that could not be found and was refused. It also cannot go stale.
    const source = await state.read<Record<string, string>>(ctx.db, STATE_KEYS.siteSource);
    const pages =
      source && Object.keys(source).length > 0
        ? inventoryFromSource(source, ctx.now)
        : await state.sitePages(ctx.db);

    if (!pages || pages.length === 0) {
      return [
        {
          type: "observation",
          summary: "No site inventory to work from",
          channel: "site",
          payload: {
            note:
              "Seed the site source with scripts/seed-site-source.mjs, or push pages to " +
              "/state/site.pages, and the agent will start finding issues.",
          },
          dedupeKey: "seo:no-inventory",
        },
      ];
    }

    const findings = findIssues(pages).slice(0, 5);
    if (findings.length === 0) {
      ctx.log("seo_site: no issues found this pass");
      return [];
    }

    const proposals: ProposedAction[] = [];

    for (const finding of findings) {
      let after = "";

      if (finding.kind === "meta_description") {
        const result = await ctx.claude.complete({
          system: SYSTEM,
          user:
            `Page: ${finding.page.path}\nTitle: ${finding.page.title ?? "(none)"}\n` +
            `Current meta description: ${finding.before || "(none)"}\n\n` +
            `Write a meta description between ${META_MIN} and ${META_MAX} characters.`,
          model: MODEL,
          effort: seoSiteAgent.effort,
          maxTokens: 400,
        });
        after = softenTells(result.text.trim().replace(/^["']|["']$/g, ""));
      } else if (finding.kind === "alt_text") {
        const result = await ctx.claude.complete({
          system: SYSTEM,
          user:
            `Page: ${finding.page.path}\nTitle: ${finding.page.title ?? "(none)"}\n` +
            `Image file: ${finding.before}\n\nWrite alt text for it. One short sentence, describing what is in the image.`,
          // Describing an image file is the most mechanical generation in the
          // system. It runs a tier below the rest of this agent.
          model: ALT_TEXT_MODEL,
          maxTokens: 200,
        });
        after = softenTells(result.text.trim().replace(/^["']|["']$/g, ""));
      } else {
        // Orphan page: the fix is a link from somewhere relevant, which is a
        // proposal about site structure rather than a piece of copy.
        const candidates = pages
          .filter((page) => page.path !== finding.page.path)
          .slice(0, 10)
          .map((page) => `${page.path} (${page.title ?? "untitled"})`)
          .join(", ");
        const result = await ctx.claude.complete({
          system: SYSTEM,
          user:
            `${finding.page.path} (${finding.page.title ?? "untitled"}) has no internal links pointing at it.\n` +
            `Other pages: ${candidates}\n\n` +
            `Name the single best page to link from, and write the sentence the link should sit in. Format: PAGE: <path>\nSENTENCE: <text>`,
          model: MODEL,
          effort: "medium",
          maxTokens: 400,
        });
        after = softenTells(result.text.trim());
      }

      const violations = scanForTells(after);
      if (violations.length > 0) after = softenTells(after);

      // Translate the finding into a substitution that names real text on the
      // page. Without this the writer received an insertion with no anchor and
      // had nothing to position against. An orphan-page finding is a structural
      // recommendation rather than a substitution, so it carries no anchor and
      // is queued for a person either way.
      const html = source?.[finding.page.path];
      let edit: { before: string; after: string } | null = null;

      if (html && finding.kind === "meta_description") {
        edit = metaDescriptionEdit(html, after);
      } else if (html && finding.kind === "alt_text") {
        edit = altTextEdit(html, finding.before, after);
      }

      // An internal link has no anchor translator in site-edits.ts, and there
      // is no honest one: where a link belongs is a judgement about the page,
      // not a substitution. Left to fall through, the proposal carried the
      // page's own path as `before` and the model's "PAGE: / SENTENCE:" reply
      // as `after` — an edit that fails every run, and would have injected that
      // reply into the page had the path ever appeared on it exactly once.
      // It is a recommendation, so it is reported as one.
      if (html && !edit) {
        // No safe anchor: say so and move on rather than attempt it.
        proposals.push({
          type: "observation",
          summary: `Cannot place the ${finding.kind} fix on ${finding.page.path}`,
          channel: "site",
          payload: {
            path: finding.page.path,
            kind: finding.kind,
            problem: finding.problem,
            drafted: after,
            note: "No unambiguous place to insert this was found, so nothing was changed.",
          },
          dedupeKey: `seo:noanchor:${finding.kind}:${finding.page.path}`,
        });
        continue;
      }

      proposals.push({
        type: "site_edit",
        summary: `${finding.kind} on ${finding.page.path}: ${finding.problem}`,
        channel: "site",
        target: finding.page.path,
        payload: {
          path: finding.page.path,
          kind: finding.kind,
          before: edit ? edit.before : finding.before,
          after: edit ? edit.after : after,
          problem: finding.problem,
          fullRestructure: false,
        },
        rationale: `${finding.problem}. Fix drafted and ready to apply.`,
        reversible: true,
        dedupeKey: `seo:${finding.kind}:${finding.page.path}`,
      });
    }

    return proposals;
  },

  async execute(action: ProposedAction, ctx: RunContext): Promise<ExecutionResult> {
    if (action.type === "observation") {
      return { outcome: "observed", detail: action.payload };
    }

    const writer = getSiteWriter(ctx.env);
    const result = await writer.write(
      {
        path: String(action.payload["path"]),
        kind: String(action.payload["kind"]),
        before: String(action.payload["before"] ?? ""),
        after: String(action.payload["after"] ?? ""),
        approvalRef: action.approvedContentRef,
      },
      ctx.db,
      ctx.env
    );

    return {
      outcome: result.applied ? "executed" : "blocked_inactive",
      externalRef: result.ref,
      detail: {
        note: result.note,
        writer: writer.name,
        path: action.payload["path"],
        kind: action.payload["kind"],
      },
    };
  },
};
