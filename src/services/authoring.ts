/**
 * House rules for content written into this wiki.
 *
 * Two constraints shape everything an agent writes here:
 *
 * 1. Pages are authored in markdown. The HTML path exists only for pages that a
 *    human wrote in BookStack's WYSIWYG editor, which have no markdown source to
 *    append to.
 * 2. There is no image upload. The BookStack API exposes an image gallery, but
 *    this server deliberately does not wrap it: an agent has no file to upload
 *    that the wiki could serve. Diagrams therefore go in as ASCII art inside a
 *    fenced code block, which stays readable, diffable and searchable.
 *
 * The prose below is spliced into the write tools' descriptions so the rules
 * reach the agent before it writes, and the validation below is the backstop for
 * when they do not.
 */

import { BookStackError } from "./client.js";

/** Shared preamble for every tool that writes page content. */
export const AUTHORING_CONVENTIONS = `Content conventions for this wiki:
  - Write the body in markdown. It is the expected format for every page here; the html
    argument exists only for pages already authored in BookStack's WYSIWYG editor.
  - Images cannot be uploaded: this server has no upload endpoint, so a link to a local
    file, a generated image or a data: URI will not render. Draw diagrams, architecture
    sketches, trees and flows as ASCII art inside a fenced code block instead. They stay
    readable, searchable and diffable, and they survive an export.
  - Do not repeat the page title as a level-1 heading; BookStack renders the title itself.
    Start sections at "## ".`;

/** Compact form of the same rules, for error hints. */
const ASCII_HINT =
  `Images cannot be uploaded through this server. Replace the image with an ASCII diagram ` +
  `inside a fenced code block, or, if the picture already lives on the web, link it by ` +
  `absolute http(s) URL.`;

/**
 * Image sources that cannot possibly resolve once the page is rendered.
 *
 * Absolute http(s) URLs are left alone: an image already hosted somewhere (the
 * wiki's own gallery included) renders fine, and deciding whether to hotlink it
 * is the author's call, not this server's. Everything else — a local path, a
 * `file://` URL, an inline `data:` blob — is a dead reference by construction.
 */
function isUnusableSource(source: string): boolean {
  const trimmed = source.trim().replace(/^<|>$/g, "");
  if (trimmed === "") return true;
  if (/^https?:\/\//i.test(trimmed)) return false;
  // A root-relative path resolves against the wiki host, so it can work — unless
  // it is plainly a filesystem path that happens to start with a slash.
  if (trimmed.startsWith("/")) return FILESYSTEM_ROOTS.test(trimmed);
  return true;
}

/**
 * Absolute paths that are filesystem locations, never wiki URL paths.
 *
 * `/uploads/images/…` is a real BookStack path and must pass; `/home/me/x.png`
 * looks identical to a naive "starts with a slash" test but is a dead reference.
 */
const FILESYSTEM_ROOTS =
  /^\/(home|Users|root|tmp|var|etc|usr|opt|srv|mnt|media|private|Volumes|dev|proc)\//;

/**
 * Blank out code spans, keeping offsets intact.
 *
 * An image reference quoted inside a fence or backticks is an example, not a
 * broken link — documenting this very rule requires writing one. Replacing the
 * code with spaces rather than deleting it keeps the scan below simple.
 */
function maskCode(content: string): string {
  return content
    .replace(/^([ \t]*)(```+|~~~+)[\s\S]*?^[ \t]*\2[ \t]*$/gm, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length))
    .replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, (block) => " ".repeat(block.length));
}

/**
 * Every image reference in `content` that will not render.
 *
 * Markdown references come first, then HTML ones — the two syntaxes are scanned
 * in separate passes, so the result is not in document order.
 */
export function findUnusableImages(raw: string): string[] {
  const content = maskCode(raw);
  const found: string[] = [];

  // Markdown: ![alt](src "title") — the src stops at whitespace or the closing paren.
  for (const match of content.matchAll(/!\[[^\]]*\]\(\s*([^)\s]*)/g)) {
    const source = match[1] ?? "";
    if (isUnusableSource(source)) found.push(source === "" ? "(empty)" : source);
  }

  // HTML: <img src="..."> — quoted or bare.
  for (const match of content.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const source = match[2] ?? match[3] ?? match[4] ?? "";
    if (isUnusableSource(source)) found.push(source === "" ? "(empty)" : source);
  }

  return found;
}

/**
 * Reject content carrying image references that cannot render.
 *
 * @throws BookStackError naming the offending sources and the ASCII alternative.
 */
export function assertNoUnusableImages(content: { markdown: string } | { html: string }): void {
  const body = "markdown" in content ? content.markdown : content.html;
  const offenders = findUnusableImages(body);
  if (offenders.length === 0) return;

  const shown = offenders.slice(0, 5).map((source) => `"${source}"`).join(", ");
  const rest = offenders.length > 5 ? ` (and ${offenders.length - 5} more)` : "";

  throw new BookStackError(
    `The content references ${offenders.length} image(s) that cannot render: ${shown}${rest}.`,
    undefined,
    ASCII_HINT,
  );
}
