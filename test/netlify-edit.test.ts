// The SEO agent edits a live site with nobody watching, so the guards around a
// substitution are the part worth testing. A replacement that silently matches
// the wrong occurrence, or a stale edit applied to a page that has since
// changed, is visible to every visitor until someone notices.

import { describe, expect, it } from "vitest";

/** Mirrors applyEdit() in src/connectors/netlify.ts. */
function applyEdit(
  source: Record<string, string>,
  edit: { path: string; before: string; after: string }
): Record<string, string> {
  const current = source[edit.path];
  if (current === undefined) {
    throw new Error(`${edit.path} is not in the site source.`);
  }
  if (!edit.before) {
    throw new Error(`This edit gives no anchor text to position against on ${edit.path}.`);
  }
  const occurrences = current.split(edit.before).length - 1;
  if (occurrences === 0) {
    throw new Error(`The text this edit replaces is no longer on ${edit.path}.`);
  }
  if (occurrences > 1) {
    throw new Error(`The text this edit replaces appears ${occurrences} times on ${edit.path}.`);
  }
  const updated = current.replace(edit.before, edit.after);
  if (updated === current) {
    throw new Error(`Applying this edit to ${edit.path} would change nothing.`);
  }
  if (updated.length < current.length * 0.5) {
    throw new Error(
      `This edit would cut ${edit.path} from ${current.length} to ${updated.length} characters.`
    );
  }
  return { ...source, [edit.path]: updated };
}

const page = (body: string) => ({ "/index.html": `<head>${body}</head>` });

describe("applying a site edit", () => {
  it("inserts a meta description where the head has none", () => {
    const source = page("<title>Velvex</title>");
    const next = applyEdit(source, {
      path: "/index.html",
      before: "<title>Velvex</title>",
      after: '<title>Velvex</title>\n<meta name="description" content="A diagnostic standard.">',
    });
    expect(next["/index.html"]).toContain('name="description"');
    expect(next["/index.html"]).toContain("<title>Velvex</title>");
  });

  it("leaves every other page untouched", () => {
    const source = { ...page("<title>A</title>"), "/faq.html": "<p>unchanged</p>" };
    const next = applyEdit(source, {
      path: "/index.html",
      before: "<title>A</title>",
      after: "<title>B</title>",
    });
    expect(next["/faq.html"]).toBe("<p>unchanged</p>");
    expect(Object.keys(next).sort()).toEqual(["/faq.html", "/index.html"]);
  });

  it("refuses a stale edit whose target text is gone", () => {
    expect(() =>
      applyEdit(page("<title>Velvex</title>"), {
        path: "/index.html",
        before: "<title>Old headline</title>",
        after: "<title>New</title>",
      })
    ).toThrow(/no longer on/);
  });

  it("refuses an ambiguous match rather than picking one", () => {
    const source = { "/index.html": "<p>Velvex</p><p>Velvex</p>" };
    expect(() =>
      applyEdit(source, { path: "/index.html", before: "<p>Velvex</p>", after: "<p>V</p>" })
    ).toThrow(/appears 2 times/);
  });

  it("refuses a page it does not hold, rather than creating one", () => {
    expect(() =>
      applyEdit(page("<title>A</title>"), { path: "/ghost.html", before: "x", after: "y" })
    ).toThrow(/not in the site source/);
  });

  // The failure this file exists to prevent. The SEO agent emitted before:""
  // for a page with no meta description, and the whole page was replaced by the
  // description. Live, on a 22kB page.
  it("refuses an edit with no anchor instead of replacing the whole page", () => {
    const html = "<html><head><title>V</title></head><body>" + "x".repeat(20000) + "</body></html>";
    expect(() =>
      applyEdit({ "/p.html": html }, {
        path: "/p.html",
        before: "",
        after: "A meta description that is only a hundred or so characters long.",
      })
    ).toThrow(/no anchor text/);
  });

  it("refuses an edit that would gut the page even with a valid anchor", () => {
    const html = "<html><body>" + "x".repeat(20000) + "</body></html>";
    expect(() =>
      applyEdit({ "/p.html": html }, {
        path: "/p.html",
        before: "x".repeat(20000),
        after: "tiny",
      })
    ).toThrow(/cut \/p\.html/);
  });

  it("refuses a no-op so it never burns a deploy", () => {
    expect(() =>
      applyEdit(page("<title>A</title>"), {
        path: "/index.html",
        before: "<title>A</title>",
        after: "<title>A</title>",
      })
    ).toThrow(/change nothing/);
  });
});
