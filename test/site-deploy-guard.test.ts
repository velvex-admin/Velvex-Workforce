// A Netlify digest deploy publishes the whole source, not the page that
// changed. So the guards inside applyEdit are only half the story: they check
// the substitution, and a substitution can be perfectly sound while the map it
// lands in is holding a page that was destroyed three runs ago.
//
// That is not hypothetical. After the empty-anchor incident the live site was
// restored but site.source was not: /index.html sat at 142 characters and
// /proof-of-concept.html at 133. Every page served correctly, so nothing
// watching the live site could see it, and the next successful edit to any page
// would have published both stubs over the real pages.
//
// criticalFindings is what the writer checks before it deploys anything.

import { describe, expect, it } from "vitest";
import { criticalFindings } from "../src/connectors/netlify.js";

const wholePage = (title: string) =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta name="description" content="A commercial architecture diagnostic.">` +
  `</head><body>${"<p>Real page content, at length.</p>".repeat(40)}</body></html>`;

const healthy = () => ({
  "/index.html": wholePage("Velvex"),
  "/proof-of-concept.html": wholePage("Proof of concept"),
  "/faq.html": wholePage("FAQ"),
});

describe("criticalFindings", () => {
  it("passes a whole site", () => {
    expect(criticalFindings(healthy())).toEqual([]);
  });

  it("catches the stub that the empty-anchor bug actually left behind", () => {
    const source = healthy();
    source["/proof-of-concept.html"] =
      "A commercial architecture diagnostic that names the constraint holding revenue flat.";
    const findings = criticalFindings(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("/proof-of-concept.html");
    expect(findings[0]!.kind).toBe("source_truncated");
  });

  it("catches a page truncated above the size floor", () => {
    const source = healthy();
    // Long enough to look like a document, but it never closes.
    source["/index.html"] = `<!doctype html><html><head><title>Velvex</title></head><body>${"<p>x</p>".repeat(400)}`;
    const findings = criticalFindings(source);
    expect(findings.map((f) => f.path)).toEqual(["/index.html"]);
    expect(findings[0]!.kind).toBe("source_not_html");
  });

  it("reports every damaged page, not just the first", () => {
    const source = healthy();
    source["/index.html"] = "142 characters of meta description, once.";
    source["/proof-of-concept.html"] = "133 characters of meta description, once.";
    expect(criticalFindings(source).map((f) => f.path).sort()).toEqual([
      "/index.html",
      "/proof-of-concept.html",
    ]);
  });

  it("ignores non-HTML assets, which have no size floor to meet", () => {
    const source: Record<string, string> = { ...healthy(), "/robots.txt": "User-agent: *\n" };
    expect(criticalFindings(source)).toEqual([]);
  });

  it("is what stands between one sound edit and a site-wide overwrite", () => {
    // The scenario in full: a correct, well-anchored edit to a healthy page,
    // in a source that is holding a stub for a different page. The edit is
    // fine. The deploy is not.
    const source = healthy();
    source["/proof-of-concept.html"] = "a stub";
    const edited = {
      ...source,
      "/faq.html": source["/faq.html"]!.replace("<title>FAQ</title>", "<title>FAQ — Velvex</title>"),
    };
    expect(criticalFindings(edited).map((f) => f.path)).toEqual(["/proof-of-concept.html"]);
  });
});
