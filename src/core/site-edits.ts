// Turning a finding into a concrete, verifiable text substitution.
//
// The SEO agent reasons semantically — "this page needs the meta description
// X". The site writer works textually: replace exactly this string with exactly
// that one. Nothing translated between the two, so an insertion arrived with no
// anchor text at all, and the writer's fallback replaced the whole page with
// the fragment meant to go inside it. A 22kB page became 134 bytes.
//
// These functions are that translation. Each returns a substitution that names
// real text already on the page, or null when no safe anchor exists — in which
// case the edit is not attempted, rather than approximated.

/** Escape a value for use inside a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface TextEdit {
  before: string;
  after: string;
}

/** True when `needle` sits exactly once in `haystack`, so a replace is unambiguous. */
function appearsOnce(haystack: string, needle: string): boolean {
  return haystack.split(needle).length - 1 === 1;
}

/**
 * Set a page's meta description.
 *
 * When one exists, the existing tag is the anchor. When none does, the closing
 * title tag is — it is the one element every page here has exactly once, and
 * placing the description straight after the title is where it belongs.
 */
export function metaDescriptionEdit(html: string, description: string): TextEdit | null {
  const tag = `<meta name="description" content="${escapeAttribute(description)}">`;

  const existing = html.match(/<meta\b[^>]*\bname=["']description["'][^>]*>/i)?.[0];
  if (existing) {
    return appearsOnce(html, existing) ? { before: existing, after: tag } : null;
  }

  const titleClose = html.match(/<\/title\s*>/i)?.[0];
  if (!titleClose || !appearsOnce(html, titleClose)) return null;

  return { before: titleClose, after: `${titleClose}\n${tag}` };
}

/**
 * Add alt text to the image with this src. The whole tag is the anchor, so the
 * replacement is verifiable and cannot land on a different image.
 */
export function altTextEdit(html: string, src: string, alt: string): TextEdit | null {
  const tag = [...html.matchAll(/<img\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((candidate) => new RegExp(`src=["']${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(candidate));

  if (!tag || !appearsOnce(html, tag)) return null;
  // Only ever add. Rewriting an alt that is already there is a copy decision,
  // not a fix, and belongs in a proposal the owner sees.
  if (/\balt=/i.test(tag)) return null;

  const after = tag.replace(/\s*\/?>$/, (close) => ` alt="${escapeAttribute(alt)}"${close.trimStart()}`);
  return { before: tag, after };
}
