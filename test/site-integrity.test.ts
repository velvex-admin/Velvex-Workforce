import { describe, expect, it } from "vitest";
import {
  MIN_CREDIBLE_HTML,
  checkStoredSource,
  compareWithServed,
  type StoredPage,
} from "../src/core/site-integrity.js";

/** A page large and complete enough to be deployable. */
const wholePage = (filler = "x".repeat(20_000)): string =>
  `<html><head><title>Velvex</title></head><body>${filler}</body></html>`;

describe("checkStoredSource", () => {
  it("passes a healthy set", () => {
    const pages: StoredPage[] = [
      { path: "/index.html", content: wholePage() },
      { path: "/faq.html", content: wholePage("y".repeat(8000)) },
      { path: "/styles.css", content: "body{color:red}".repeat(500) },
    ];
    expect(checkStoredSource(pages)).toEqual([]);
  });

  // The real incident: the live site served correctly while site.source held
  // the meta descriptions that had overwritten two pages. Byte-checking the
  // live site could not see it; this is the check that can.
  it("catches the exact corruption found on 2026-08-22", () => {
    const pages: StoredPage[] = [
      {
        path: "/index.html",
        content:
          "Third-party diagnostic that audits your architecture before scaling. " +
          "Executive Ledger in 24 hours. Find where your business breaks under load.",
      },
      {
        path: "/proof-of-concept.html",
        content:
          "Velvex proof of concept: how a Veĺa audit surfaces load-bearing " +
          "dependencies before capital moves. See a scored assessment structure.",
      },
      { path: "/faq.html", content: wholePage("z".repeat(8000)) },
    ];

    const findings = checkStoredSource(pages);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === "source_truncated")).toBe(true);
    expect(findings.every((f) => f.severity === "critical")).toBe(true);
    expect(findings.map((f) => f.path)).toEqual(["/index.html", "/proof-of-concept.html"]);
  });

  it("ignores non-HTML files, which are legitimately small", () => {
    expect(checkStoredSource([{ path: "/site.js", content: "console.log(1)" }])).toEqual([]);
  });

  // A stub that lands above the size floor is still not a page.
  it("catches a large fragment that is not a whole document", () => {
    const findings = checkStoredSource([
      { path: "/index.html", content: "a".repeat(MIN_CREDIBLE_HTML + 500) },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("source_not_html");
  });

  it("catches a document truncated before its closing tag", () => {
    const findings = checkStoredSource([
      { path: "/index.html", content: `<html><head><title>V</title></head><body>${"q".repeat(5000)}` },
    ]);
    expect(findings[0]!.kind).toBe("source_not_html");
    expect(findings[0]!.detail).toContain("</html>");
  });
});

describe("compareWithServed", () => {
  const pages: StoredPage[] = [{ path: "/index.html", content: wholePage("m".repeat(25_000)) }];
  const size = pages[0]!.content.length;

  it("tolerates the normal gap between served and stored bytes", () => {
    // Netlify rewrites the served bytes; ~4% apart is the observed reality.
    const served = [{ path: "/index.html", ok: true, status: 200, bytes: Math.round(size * 1.04) }];
    expect(compareWithServed(pages, served)).toEqual([]);
  });

  it("reports a page that has genuinely diverged", () => {
    const served = [{ path: "/index.html", ok: true, status: 200, bytes: Math.round(size * 0.4) }];
    const findings = compareWithServed(pages, served);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("size_drift");
    expect(findings[0]!.severity).toBe("warning");
  });

  it("reports a page that is down", () => {
    const served = [{ path: "/index.html", ok: false, status: 404, bytes: 0 }];
    const findings = compareWithServed(pages, served);
    expect(findings[0]!.kind).toBe("page_unreachable");
    expect(findings[0]!.severity).toBe("critical");
  });

  // The manifest is the whole site, so a live file we hold no copy of is a
  // file the next deploy deletes.
  it("reports a live path missing from our source", () => {
    const served = [
      { path: "/index.html", ok: true, status: 200, bytes: size },
      { path: "/pricing.html", ok: true, status: 200, bytes: 9000 },
    ];
    const findings = compareWithServed(pages, served);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("source_missing");
    expect(findings[0]!.path).toBe("/pricing.html");
  });
});
