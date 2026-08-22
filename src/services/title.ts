/**
 * Removal of a body heading that merely repeats the page title.
 *
 * BookStack renders the page name as the page's own H1, so a body that opens
 * with `# Same Title` shows the title twice. Agents writing markdown tend to add
 * that heading out of habit, so the server strips it rather than relying on the
 * tool description alone being read.
 *
 * Only a leading heading that matches the title is removed, and only the first
 * one: a body whose opening heading says something else is left untouched.
 *
 * The same folding rule is exposed as `titlesMatch`, used to confirm a title a
 * caller typed back before a destructive operation runs on it.
 */

/** Fold a heading and a title to a form where cosmetic differences don't matter. */
function normalize(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[*_`~]/g, "") // markdown emphasis and code ticks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](link) -> text
    .replace(/\s+/g, " ")
    .replace(/[.:;!?]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * True when two titles are the same once cosmetic differences are folded away.
 *
 * Case, surrounding whitespace, markdown emphasis and trailing punctuation are
 * ignored, so a caller retyping a title need not reproduce it byte for byte.
 */
export function titlesMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** True when `content` opens with a level-1 heading, whatever its text. */
export function startsWithTopHeading(content: { markdown: string } | { html: string }): boolean {
  if ("markdown" in content) {
    const body = content.markdown.replace(/^\s+/, "");
    return /^#\s/.test(body) || /^[^\n]+\n[ \t]*=+[ \t]*(\n|$)/.test(body);
  }
  return /^\s*<h1[\s>]/i.test(content.html);
}

/**
 * Drop a leading H1 from markdown when it repeats `title`.
 *
 * Handles both ATX (`# Title`, with or without closing hashes) and setext
 * (`Title` underlined with `===`) headings.
 */
function stripMarkdownTitle(markdown: string, title: string): string | undefined {
  const leading = markdown.match(/^\s*/)?.[0] ?? "";
  const body = markdown.slice(leading.length);
  const wanted = normalize(title);

  const atx = body.match(/^#[ \t]+([^\n]*?)[ \t]*#*[ \t]*(?:\n|$)/);
  if (atx && normalize(atx[1] ?? "") === wanted) {
    return body.slice(atx[0].length).replace(/^\s*\n/, "");
  }

  const setext = body.match(/^([^\n]+)\n[ \t]*=+[ \t]*(?:\n|$)/);
  if (setext && normalize(setext[1] ?? "") === wanted) {
    return body.slice(setext[0].length).replace(/^\s*\n/, "");
  }

  return undefined;
}

/** Drop a leading `<h1>` from HTML when it repeats `title`. */
function stripHtmlTitle(html: string, title: string): string | undefined {
  const match = html.match(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i);
  if (!match) return undefined;
  const text = (match[1] ?? "").replace(/<[^>]+>/g, "");
  if (normalize(text) !== normalize(title)) return undefined;
  return html.slice(match[0].length);
}

/**
 * Return `content` without a leading heading duplicating `title`.
 *
 * @returns The content to send, and whether a heading was actually removed —
 * callers report the removal so the agent stops emitting it.
 */
export function withoutDuplicateTitle<T extends { markdown: string } | { html: string }>(
  content: T,
  title: string | undefined,
): { content: T; stripped: boolean } {
  if (!title || title.trim() === "") return { content, stripped: false };

  if ("markdown" in content) {
    const body = stripMarkdownTitle(content.markdown, title);
    if (body === undefined) return { content, stripped: false };
    return { content: { markdown: body } as T, stripped: true };
  }

  const body = stripHtmlTitle(content.html, title);
  if (body === undefined) return { content, stripped: false };
  return { content: { html: body } as T, stripped: true };
}
