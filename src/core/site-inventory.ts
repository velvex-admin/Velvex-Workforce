// Building the SEO agent's inventory from the site source we hold.
//
// The inventory used to be seeded separately, by fetching the live site. That
// created two problems. The paths did not match — the fetcher used "/faq" while
// the source keys are "/faq.html" — so every edit the agent proposed pointed at
// a path the writer could not find and was refused. And the inventory could
// silently fall behind the source, leaving the agent reasoning about a page
// that no longer looked that way.
//
// Deriving it from `site.source` removes both. There is one source of truth,
// the paths are the same keys the writer uses, and the inventory cannot drift
// because it is computed fresh each run.
//
// The parsing is deliberately plain. This reports what a page currently has;
// deciding what is wrong with it is the agent's job, not this file's.

import type { SitePage } from "./state.js";

const capture = (html: string, re: RegExp): string | undefined => html.match(re)?.[1]?.trim();

/** Visible words, with script and style contents removed first. */
function wordCount(html: string): number {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
  return body.split(/\s+/).filter(Boolean).length;
}

function images(html: string): Array<{ src: string; alt?: string }> {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => {
    const tag = match[0];
    const alt = capture(tag, /alt=["']([^"']*)["']/i);
    return {
      src: capture(tag, /src=["']([^"']+)["']/i) ?? "",
      // An absent alt and an empty alt are different things: empty is a valid
      // way to mark an image decorative, absent is an omission. Preserve both.
      ...(alt === undefined ? {} : { alt }),
    };
  });
}

/**
 * Links pointing at another page in this same site, as site paths.
 *
 * The href on the page and the key in the source are not written the same way:
 * the site links relatively ("faq.html") while the source is keyed absolutely
 * ("/faq.html"). This normalises before returning, not only before testing
 * membership. Returning the raw href meant the inbound tally was keyed
 * "faq.html" while every lookup asked for "/faq.html", so every page counted
 * zero inbound links and the SEO agent called all three of them orphans.
 */
function internalLinks(html: string, paths: Set<string>): string[] {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .map((href) => {
      if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href)) return "";
      const normalised = href.startsWith("/") ? href : `/${href}`;
      return normalised.split(/[?#]/)[0] ?? "";
    })
    .filter((path) => path !== "" && paths.has(path));
}

/**
 * One SitePage per HTML file in the source. Non-HTML files (CSS, JS) are not
 * pages and are skipped — they are still deployed, just not analysed.
 */
export function inventoryFromSource(source: Record<string, string>, now = new Date()): SitePage[] {
  const htmlPaths = Object.keys(source).filter((path) => path.endsWith(".html"));
  const pathSet = new Set(htmlPaths);

  // Count, across the whole site, how many pages link to each page.
  const inbound = new Map<string, number>();
  for (const path of htmlPaths) {
    for (const target of internalLinks(source[path] ?? "", pathSet)) {
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }

  return htmlPaths.sort().map((path) => {
    const html = source[path] ?? "";
    const title = capture(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDescription = capture(
      html,
      /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i
    );

    return {
      path,
      ...(title === undefined ? {} : { title }),
      ...(metaDescription === undefined ? {} : { metaDescription }),
      wordCount: wordCount(html),
      images: images(html),
      inboundInternalLinks: inbound.get(path) ?? 0,
      updatedAt: now.toISOString(),
    };
  });
}
