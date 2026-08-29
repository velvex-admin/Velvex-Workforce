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

// ---------------------------------------------------------------------------
// Automatic restoration.
//
// Reporting a ruined site is worth nothing if nobody is reading. The owner may
// be asleep, and the SEO agent deploys the whole manifest — so between one
// hourly check and the next, the live site can be a set of stubs with no one
// watching. This decides, deterministically, whether the site is RUINED rather
// than merely different, because the difference between those two words is the
// difference between rescuing a site and reverting someone's redesign.
// ---------------------------------------------------------------------------

/** A source verified healthy, kept so there is something safe to go back to. */
export interface KnownGoodSource {
  savedAt: string;
  files: Record<string, string>;
}

/**
 * How many automatic restores may happen in one day.
 *
 * A restore that does not fix the problem will be re-triggered on the next
 * hourly check, and an agent redeploying the same files every hour forever is
 * worse than a broken page: it is a broken page plus a deploy loop. Past this,
 * it stops acting and says so.
 */
export const MAX_RESTORES_PER_DAY = 2;

export interface RestoreLedger {
  /** ISO timestamps of restores already performed. */
  at: string[];
}

export interface DamageVerdict {
  ruined: boolean;
  /** Plain reasons, for the report the owner reads afterwards. */
  reasons: string[];
}

/**
 * Is the site RUINED, as opposed to changed?
 *
 * Only damage counts, never difference. A page that was rewritten, retitled or
 * restructured is not damage: the owner is allowed to change their own site,
 * and an agent that reverted a redesign because it did not recognise it would
 * be far more destructive than the failure this guards against.
 *
 * Damage is the shape of the incident that prompted all of this: a page that
 * collapsed to a fragment, a page that stopped being HTML, or a page that stopped
 * answering. Each of those is a fact, not a judgement.
 */
export function assessDamage(
  stored: StoredPage[],
  served: ServedPage[],
  knownGood: KnownGoodSource | null
): DamageVerdict {
  const reasons: string[] = [];

  // Nothing to go back to means nothing to decide. Saying so is the honest
  // outcome; acting on a source we never verified would be the reckless one.
  if (!knownGood || Object.keys(knownGood.files).length === 0) {
    return { ruined: false, reasons: [] };
  }

  for (const page of stored) {
    if (!isHtmlPath(page.path)) continue;
    const good = knownGood.files[page.path];
    if (typeof good !== "string") continue;

    // Collapsed to a fragment. This is the exact failure that happened: a 22kB
    // page went live as a 134-byte meta description.
    if (page.content.length < MIN_CREDIBLE_HTML && good.length >= MIN_CREDIBLE_HTML) {
      reasons.push(
        `${page.path} is ${page.content.length} characters in the stored source, against ` +
          `${good.length} in the last verified copy. That is a fragment, not a page.`
      );
      continue;
    }

    // Lost more than half its body while the known-good copy was a real page.
    if (good.length >= MIN_CREDIBLE_HTML && page.content.length < good.length * 0.5) {
      reasons.push(
        `${page.path} lost more than half its content: ${good.length} characters to ` +
          `${page.content.length}.`
      );
      continue;
    }

    // Stopped being a document at all.
    if (!/<\/title>/i.test(page.content) || !/<\/html>/i.test(page.content)) {
      reasons.push(`${page.path} is no longer a complete HTML document in the stored source.`);
    }
  }

  // A page that was live and now answers with an error. Checked against the
  // known-good set so a path the owner deliberately removed is not "damage".
  for (const page of served) {
    if (page.ok) continue;
    if (typeof knownGood.files[page.path] !== "string") continue;
    // Status 0 is our own network failing, not the site. Never act on it.
    if (page.status === 0) continue;
    reasons.push(`${page.path} returns HTTP ${page.status} on the live site.`);
  }

  return { ruined: reasons.length > 0, reasons };
}

/** Restores performed within the last 24 hours of `now`. */
export function restoresToday(ledger: RestoreLedger | null, now: Date): number {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return (ledger?.at ?? []).filter((stamp) => {
    const at = Date.parse(stamp);
    return Number.isFinite(at) && at >= cutoff;
  }).length;
}

/** Whether a source is sound enough to be promoted to the known-good copy. */
export function isPromotable(stored: StoredPage[]): boolean {
  if (stored.length === 0) return false;
  return checkStoredSource(stored).every((finding) => finding.severity !== "critical");
}
