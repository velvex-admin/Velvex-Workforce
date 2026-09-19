// The two files a site needs before a crawler can find the rest of it.
//
// This is the answer to "the SEO agent has nothing to do" and to "I search
// Velvex and my site does not come up", and those turned out to be the same
// gap. findIssues() looks for a missing meta description, a missing alt
// attribute and a page nothing links to. All three change how a result READS
// once it already ranks. None of them is how a page gets INDEXED, and on
// 2026-09-03 the live site answered 404 for both /robots.txt and /sitemap.xml,
// so the only route Google had to the two inner pages was following links from
// a home page it had to find first.
//
// Both files are generated from the source we already hold rather than written
// by hand or by a model. That is the whole reason they can be routine: there is
// no judgement in either, so there is nothing for a model to get wrong and
// nothing for a person to approve. Add a page to the site and the next run
// notices the sitemap no longer matches and refreshes it.

/** Where each generated file lives in the source map. */
export const SITEMAP_PATH = "/sitemap.xml";
export const ROBOTS_PATH = "/robots.txt";

/** The only paths the generated-file writer will ever create. */
export const GENERATED_PATHS = [SITEMAP_PATH, ROBOTS_PATH] as const;

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);

/**
 * The URL a page is actually served at, from the key it is stored under.
 *
 * The source is keyed by file name ("/faq.html") because that is what a file
 * deploy uploads. Netlify's Pretty URLs post-processing serves the same page at
 * "/faq" AND rewrites every internal link in the served HTML to the
 * extensionless form — so the URL Google discovers by crawling is "/faq", and
 * the file name never appears in anything it reads. Measured 2026-09-03: both
 * forms return 200, neither redirects to the other.
 *
 * That last fact is the reason this matters rather than being cosmetic. Two
 * URLs serving one page with no redirect and no canonical is a duplicate: the
 * crawler picks one on its own and any signal earned by the other is spent on a
 * page nobody chose. The sitemap is where we say which one is meant, so it has
 * to name the form the links point at.
 */
export function canonicalPath(sourcePath: string): string {
  if (!/\.html?$/i.test(sourcePath)) return sourcePath;
  const withoutExtension = sourcePath.replace(/\.html?$/i, "");
  // A directory index is the directory, not a page called "index".
  return withoutExtension.replace(/(^|\/)index$/i, "$1") || "/";
}

/** Absolute URL for a stored path, against a site base with no trailing slash. */
export function canonicalUrl(siteUrl: string, sourcePath: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${canonicalPath(sourcePath)}`;
}

/**
 * The sitemap for everything in the source that is a page.
 *
 * Deliberately no <lastmod>, and the reason is not laziness in both directions
 * at once. We do not record when a page last changed, so any date written here
 * would be the date the file was GENERATED — which is today, every day, for
 * every page. That is worse than absent twice over: Google ignores a lastmod it
 * finds unreliable, and a value that moves on every run makes the stored file
 * differ from the freshly built one on every run, so the agent would propose
 * the identical edit and redeploy the whole site daily, for ever. Determinism
 * here is what makes "is this stale" a question with an honest answer.
 *
 * <changefreq> and <priority> are omitted because Google ignores both outright.
 */
export function buildSitemap(source: Record<string, string>, siteUrl: string): string {
  const urls = Object.keys(source)
    .filter((path) => /\.html?$/i.test(path))
    .map((path) => canonicalUrl(siteUrl, path))
    // Sorted so the output depends on the set of pages and nothing else. Object
    // key order is an implementation detail and would otherwise decide whether
    // the agent thinks the sitemap changed.
    .sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length));

  const entries = urls.map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`);

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${entries.join("\n")}\n` +
    "</urlset>\n"
  );
}

/**
 * robots.txt.
 *
 * Its real job here is the Sitemap line. Crawling was never blocked — there was
 * no file at all, which a crawler treats as "allowed" anyway — so the "Allow"
 * changes nothing and is written only because a robots.txt that states nothing
 * reads like an accident. The Sitemap line is the part that does work: it is
 * the one place a crawler looks for the map without being told where it is.
 */
export function buildRobots(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  return `User-agent: *\nAllow: /\n\nSitemap: ${base}${SITEMAP_PATH}\n`;
}

/** What each generated file should currently contain, keyed by its path. */
export function generatedFiles(
  source: Record<string, string>,
  siteUrl: string
): Record<string, string> {
  return {
    [SITEMAP_PATH]: buildSitemap(source, siteUrl),
    [ROBOTS_PATH]: buildRobots(siteUrl),
  };
}
