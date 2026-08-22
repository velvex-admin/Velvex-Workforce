// Checking that the site source we deploy from is still a site.
//
// `site.source` is the source of truth: whatever it holds becomes the next
// Netlify deploy, and a path missing from the manifest is deleted. So a
// corrupt entry in that table is a live site waiting to be destroyed, not a
// stale cache.
//
// That is not hypothetical. After the empty-anchor incident the live site was
// restored, but `site.source` was not: /index.html sat at 142 characters and
// /proof-of-concept.html at 133 — the meta descriptions that had overwritten
// them. Both pages served correctly the whole time, so nothing that watched
// the live site could have noticed. The first successful edit to any page
// would have published those stubs over the real ones.
//
// The checks below are deliberately arithmetic and string matching. No model:
// "this file is 133 characters and has no closing html tag" is not a
// judgement call, and this runs hourly.

/** A stored page smaller than this cannot be a real HTML document. */
export const MIN_CREDIBLE_HTML = 1000;

/**
 * How far the served page may differ in size from the stored one before it is
 * worth reporting. Netlify post-processing rewrites the served bytes, so these
 * never match exactly and an equality check would cry wolf every hour.
 */
export const SIZE_DRIFT_TOLERANCE = 0.25;

export interface StoredPage {
  path: string;
  content: string;
}

export interface ServedPage {
  path: string;
  ok: boolean;
  status: number;
  bytes: number;
}

export type FindingKind =
  | "source_truncated"
  | "source_not_html"
  | "page_unreachable"
  | "size_drift"
  | "source_missing";

export interface IntegrityFinding {
  kind: FindingKind;
  path: string;
  detail: string;
  severity: "critical" | "warning";
}

const isHtmlPath = (path: string): boolean => /\.html?$/i.test(path);

/**
 * Everything wrong with the stored source on its own terms, before the live
 * site is consulted at all. This is the check that would have caught the
 * corruption, and it needs no network.
 */
export function checkStoredSource(pages: StoredPage[]): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];

  for (const page of pages) {
    if (!isHtmlPath(page.path)) continue;

    if (page.content.length < MIN_CREDIBLE_HTML) {
      findings.push({
        kind: "source_truncated",
        path: page.path,
        detail:
          `Stored source for ${page.path} is ${page.content.length} characters. ` +
          `Anything under ${MIN_CREDIBLE_HTML} is not a page, it is a fragment that replaced one. ` +
          `Deploying this would publish the fragment over the live page.`,
        severity: "critical",
      });
      continue;
    }

    // A truncation that happens to land above the size floor still shows here:
    // a document that opens a tag set it never closes is not deployable.
    const hasHtmlClose = /<\/html\s*>/i.test(page.content);
    const hasTitle = /<\/title\s*>/i.test(page.content);
    if (!hasHtmlClose || !hasTitle) {
      findings.push({
        kind: "source_not_html",
        path: page.path,
        detail:
          `Stored source for ${page.path} is missing ${!hasTitle ? "a closing </title>" : ""}` +
          `${!hasTitle && !hasHtmlClose ? " and " : ""}${!hasHtmlClose ? "a closing </html>" : ""}. ` +
          `The file is ${page.content.length} characters, so it is large enough to look intact but is not a whole document.`,
        severity: "critical",
      });
    }
  }

  return findings;
}

/**
 * What the live site says, compared against what we hold. Reported as warnings
 * rather than critical: served bytes legitimately differ from stored ones, and
 * only a large gap suggests the two have genuinely parted company.
 */
export function compareWithServed(
  pages: StoredPage[],
  served: ServedPage[]
): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const stored = new Map(pages.map((page) => [page.path, page.content]));

  for (const page of served) {
    if (!page.ok) {
      findings.push({
        kind: "page_unreachable",
        path: page.path,
        detail: `${page.path} returned HTTP ${page.status} on the live site.`,
        severity: "critical",
      });
      continue;
    }

    const content = stored.get(page.path);
    if (content === undefined) {
      // A live path we hold no copy of would be deleted by the next deploy,
      // because the manifest we send is the whole site.
      findings.push({
        kind: "source_missing",
        path: page.path,
        detail:
          `${page.path} is live but absent from site.source. A deploy sends the full manifest, ` +
          `so publishing any edit would delete this file from the site.`,
        severity: "critical",
      });
      continue;
    }

    if (content.length === 0) continue;
    const drift = Math.abs(page.bytes - content.length) / content.length;
    if (drift > SIZE_DRIFT_TOLERANCE) {
      findings.push({
        kind: "size_drift",
        path: page.path,
        detail:
          `${page.path} is served as ${page.bytes} bytes but stored as ${content.length}. ` +
          `That is ${Math.round(drift * 100)}% apart, past the ${Math.round(SIZE_DRIFT_TOLERANCE * 100)}% tolerance, ` +
          `so our copy and the live page have probably diverged.`,
        severity: "warning",
      });
    }
  }

  return findings;
}
