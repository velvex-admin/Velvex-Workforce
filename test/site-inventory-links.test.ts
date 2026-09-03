// The site was rewritten on 2026-09-03 and every internal href changed shape
// with it: the old build linked "faq.html", the new one links "/faq". The
// source is keyed by file name either way, so a membership test against the
// raw href stops matching the moment the source is re-seeded from the new
// folder — and every page becomes an orphan on a site whose navigation links
// all three of them, in view, on every page.
//
// The nav below is copied from the live homepage, single quotes and all.

import { describe, expect, it } from "vitest";
import { inventoryFromSource } from "../src/core/site-inventory.js";

const NAV =
  "<a class='nav-link active' href='/'>Home</a>" +
  "<a class='nav-link' href='/proof-of-concept'>Proof of Concept</a>" +
  "<a class='nav-link' href='/faq'>FAQ</a>" +
  '<a href="https://tally.so/r/Zjz6Oy">Book</a>' +
  '<a href="mailto:velvex.support@gmail.com">Mail</a>' +
  '<a href="#methodology">Method</a>';

const page = (body: string) => `<html><head><title>t</title></head><body>${NAV}${body}</body></html>`;

const SOURCE: Record<string, string> = {
  "/index.html": page("<p>home</p>"),
  "/faq.html": page("<p>faq</p>"),
  "/proof-of-concept.html": page("<p>poc</p>"),
  "/styles.css": "body{}",
};

const byPath = (pages: ReturnType<typeof inventoryFromSource>) =>
  Object.fromEntries(pages.map((p) => [p.path, p.inboundInternalLinks ?? 0]));

describe("internal links on the rewritten site", () => {
  it("counts an extensionless href against the page it actually serves", () => {
    const counts = byPath(inventoryFromSource(SOURCE));
    // Three pages, each carrying the nav, so each target is linked three times.
    expect(counts["/faq.html"]).toBe(3);
    expect(counts["/proof-of-concept.html"]).toBe(3);
    // "/" is the home page, and it resolves to /index.html.
    expect(counts["/index.html"]).toBe(3);
  });

  it("calls nothing an orphan when the navigation links everything", () => {
    const orphans = inventoryFromSource(SOURCE).filter((p) => (p.inboundInternalLinks ?? 0) === 0);
    expect(orphans.map((p) => p.path)).toEqual([]);
  });

  it("still counts the old build's relative hrefs, so a re-seed is safe either way", () => {
    const old = {
      "/index.html": '<html><body><a href="faq.html">FAQ</a></body></html>',
      "/faq.html": "<html><body>faq</body></html>",
    };
    expect(byPath(inventoryFromSource(old))["/faq.html"]).toBe(1);
  });

  it("does not invent a page for a link that goes nowhere", () => {
    const withDeadLink = {
      "/index.html": '<html><body><a href="/pricing">Pricing</a></body></html>',
    };
    const pages = inventoryFromSource(withDeadLink);
    expect(pages.map((p) => p.path)).toEqual(["/index.html"]);
    expect(pages[0]?.inboundInternalLinks).toBe(0);
  });
});
