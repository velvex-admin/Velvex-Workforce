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
  const occurrences = edit.before ? current.split(edit.before).length - 1 : 0;
  if (edit.before && occurrences === 0) {
    throw new Error(`The text this edit replaces is no longer on ${edit.path}.`);
  }
  if (occurrences > 1) {
    throw new Error(`The text this edit replaces appears ${occurrences} times on ${edit.path}.`);
  }
  const updated = edit.before ? current.replace(edit.before, edit.after) : edit.after;
  if (updated === current) {
    throw new Error(`Applying this edit to ${edit.path} would change nothing.`);
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
