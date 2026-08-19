#!/usr/bin/env node
// Builds the site inventory the SEO / Site agent works from, by reading the
// live site. Run it whenever the site changes.
//
//   node scripts/seed-site-inventory.mjs                    # print the JSON
//   VX_URL='https://velvex-vx03.<sub>.workers.dev' \
//   VX_PATH_SECRET='<APP_PATH_SECRET>' \
//     node scripts/seed-site-inventory.mjs --push           # send it to the app
//
// The agent finds its own issues from this inventory; nothing here decides what
// is wrong. It only reports what each page currently has.

const SITE = process.env.VX_SITE ?? "https://velvex-site.netlify.app";
const PATHS = ["/", "/faq", "/proof-of-concept"];

const text = (html, re) => html.match(re)?.[1]?.trim();

function parse(path, html) {
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => ({
    src: text(match[0], /src=["']([^"']+)["']/i) ?? "",
    alt: text(match[0], /alt=["']([^"']*)["']/i),
  }));

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return {
    path,
    title: text(html, /<title>([^<]*)<\/title>/i),
    metaDescription: text(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i),
    wordCount: body.split(/\s+/).filter(Boolean).length,
    images,
    // Counted below, once every page has been read.
    inboundInternalLinks: 0,
    outboundInternalLinks: [
      ...new Set(
        [...html.matchAll(/href=["']([^"']+)["']/gi)]
          .map((match) => match[1])
          .filter((href) => href.startsWith("/"))
      ),
    ],
    updatedAt: new Date().toISOString(),
  };
}

const pages = [];
for (const path of PATHS) {
  const res = await fetch(`${SITE}${path}`);
  if (!res.ok) {
    console.error(`skipping ${path}: HTTP ${res.status}`);
    continue;
  }
  pages.push(parse(path, await res.text()));
}

// Inbound link counts, so the agent can spot an orphan page for real. Counted
// across every page first, then the working field is dropped.
for (const page of pages) {
  page.inboundInternalLinks = pages.filter(
    (other) => other.path !== page.path && other.outboundInternalLinks.includes(page.path)
  ).length;
}
for (const page of pages) delete page.outboundInternalLinks;

if (!process.argv.includes("--push")) {
  console.log(JSON.stringify(pages, null, 2));
  console.error(
    `\n${pages.length} pages read. ` +
      `${pages.filter((p) => !p.metaDescription).length} have no meta description.`
  );
  process.exit(0);
}

const base = process.env.VX_URL;
const secret = process.env.VX_PATH_SECRET;
if (!base || !secret) {
  console.error("--push needs VX_URL and VX_PATH_SECRET set.");
  process.exit(1);
}

const push = await fetch(`${base.replace(/\/+$/, "")}/x/${secret}/api/state/site.pages`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(pages),
});

console.log(push.ok ? `pushed ${pages.length} pages` : `push failed: HTTP ${push.status}`);
process.exit(push.ok ? 0 : 1);
