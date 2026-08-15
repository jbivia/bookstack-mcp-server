/**
 * Page tools: the read/write core of the server.
 *
 * BookStack stores a page either as markdown (with rendered HTML alongside) or
 * as HTML only, depending on how it was authored. Everything here prefers
 * markdown and falls back to HTML explicitly rather than silently, so the agent
 * always knows which representation it is looking at.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest, BookStackError } from "../services/client.js";
import { fetchList } from "../services/list.js";
import { summarize, renderSummary, type EntitySummary } from "../services/entities.js";
import { attachPageUrl } from "../services/links.js";
import { startsWithTopHeading, withoutDuplicateTitle } from "../services/title.js";
import { AUTHORING_CONVENTIONS, assertNoUnusableImages } from "../services/authoring.js";
import {
  capListing,
  capText,
  line,
  lines,
  paginate,
  paginationFooter,
  toolFailure,
  toolSuccess,
  type Paginated,
} from "../services/format.js";
import {
  entitySummaryShape,
  paginationOutputShape,
  paginationShape,
  responseFormatField,
  sortField,
  tagsField,
} from "../schemas/common.js";
import type { BookStackPage } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

interface PageSummary extends EntitySummary {
  book_id: number;
  chapter_id?: number;
  draft?: boolean;
}

const pageSummaryShape = {
  ...entitySummaryShape,
  book_id: z.number().describe("Id of the containing book."),
  chapter_id: z.number().optional().describe("Id of the containing chapter, when there is one."),
  draft: z.boolean().optional().describe("Whether the page is an unpublished draft."),
};

function toPageSummary(page: BookStackPage): PageSummary {
  return {
    ...summarize(page),
    book_id: page.book_id,
    ...(page.chapter_id ? { chapter_id: page.chapter_id } : {}),
    ...(page.draft ? { draft: page.draft } : {}),
  };
}

/**
 * Pick the content field to send to BookStack.
 *
 * @throws BookStackError when neither field is usable, with a hint naming the fix.
 */
/** Told to the agent whenever a title-duplicating heading was removed for it. */
const TITLE_STRIPPED_NOTICE =
  "_Note: the body opened with a level-1 heading repeating the page title, which BookStack " +
  "renders on its own. It was removed; start future bodies at heading level 2._";

type PageContent = { markdown: string } | { html: string };

function resolveContent(
  markdown: string | undefined,
  html: string | undefined,
  required: true,
): PageContent;
function resolveContent(
  markdown: string | undefined,
  html: string | undefined,
  required: boolean,
): PageContent | undefined;
function resolveContent(
  markdown: string | undefined,
  html: string | undefined,
  required: boolean,
): PageContent | undefined {
  const hasMarkdown = markdown !== undefined && markdown.trim() !== "";
  const hasHtml = html !== undefined && html.trim() !== "";

  if (hasMarkdown && hasHtml) {
    throw new BookStackError(
      "Both markdown and html were provided.",
      undefined,
      "Send only one of them; markdown is preferred for pages written by an agent.",
    );
  }
  // Validated here rather than at each call site: this is the single funnel
  // through which every byte of page content passes.
  if (hasMarkdown) {
    const content = { markdown: markdown as string };
    assertNoUnusableImages(content);
    return content;
  }
  if (hasHtml) {
    const content = { html: html as string };
    assertNoUnusableImages(content);
    return content;
  }
  if (required) {
    throw new BookStackError(
      "No page content was provided.",
      undefined,
      "Pass either markdown (preferred) or html with the page body.",
    );
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* bookstack_list_pages                                                        */
/* -------------------------------------------------------------------------- */

const listPagesShape = {
  ...paginationShape,
  book_id: z.number().int().positive().optional().describe("Restrict to pages in this book."),
  chapter_id: z.number().int().positive().optional().describe("Restrict to pages in this chapter."),
  name_contains: z.string().optional().describe("Case-insensitive substring filter on the page title."),
  sort: sortField,
  response_format: responseFormatField,
};
type ListPagesArgs = z.infer<z.ZodObject<typeof listPagesShape>>;

function renderPages(payload: Paginated<PageSummary>): string {
  const header = `# Pages\n\n${payload.total} total, showing ${payload.count}.\n`;
  const blocks = payload.items.map((item) =>
    renderSummary(item, "##", [
      line("Book id", item.book_id),
      line("Chapter id", item.chapter_id),
      item.draft ? "- **Draft**: yes" : undefined,
    ]),
  );
  return `${header}\n${blocks.join("\n\n")}${paginationFooter(payload)}`;
}

/* -------------------------------------------------------------------------- */
/* bookstack_get_page                                                          */
/* -------------------------------------------------------------------------- */

const getPageShape = {
  page_id: z.number().int().positive().describe("Id of the page, from a search or listing result."),
  content_format: z
    .enum(["markdown", "html", "none"])
    .default("markdown")
    .describe(
      "Which body representation to return. 'markdown' (default) falls back to html when the page " +
        "was authored in the WYSIWYG editor. 'none' returns metadata only, which is much cheaper.",
    ),
  response_format: responseFormatField,
};
type GetPageArgs = z.infer<z.ZodObject<typeof getPageShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_create_page                                                       */
/* -------------------------------------------------------------------------- */

const createPageShape = {
  name: z.string().min(1, "Name is required").max(255).describe("Title of the new page."),
  book_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Id of the containing book. Required unless chapter_id is given."),
  chapter_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Id of the containing chapter. Takes precedence over book_id when both are given."),
  markdown: z
    .string()
    .optional()
    .describe(
      "Page body in markdown, the expected format for pages in this wiki. Do NOT open it with " +
        "a level-1 heading repeating `name`: BookStack already renders the title as the page's " +
        "H1, so that heading would show up twice. Start at '## ' for the first section. Images " +
        "cannot be uploaded; use ASCII art in a fenced code block for diagrams.",
    ),
  html: z
    .string()
    .optional()
    .describe(
      "Page body in HTML. Reserved for pages authored in the WYSIWYG editor; new pages should " +
        "use markdown. Do NOT open it with an <h1> repeating `name`; BookStack renders the " +
        "title itself. Start at <h2>. No <img>: use a <pre> ASCII diagram instead.",
    ),
  tags: tagsField,
};
type CreatePageArgs = z.infer<z.ZodObject<typeof createPageShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_update_page                                                       */
/* -------------------------------------------------------------------------- */

const updatePageShape = {
  page_id: z.number().int().positive().describe("Id of the page to update."),
  mode: z
    .enum(["append", "prepend", "replace"])
    .default("append")
    .describe(
      "How to apply the new content. 'append' (default) adds it at the end and preserves what is " +
        "already there; 'prepend' adds it at the top; 'replace' overwrites the whole body. " +
        "Prefer append when adding notes to a living page.",
    ),
  markdown: z
    .string()
    .optional()
    .describe(
      "Content to apply, in markdown. In replace/prepend mode do not open it with a level-1 " +
        "heading repeating the page title: BookStack renders the title as the page's H1 already.",
    ),
  html: z
    .string()
    .optional()
    .describe(
      "Content to apply, in HTML. Only valid on HTML-authored pages. In replace/prepend mode do " +
        "not open it with an <h1> repeating the page title.",
    ),
  name: z.string().min(1).max(255).optional().describe("New title. Omit to keep the current one."),
  tags: tagsField,
  separator: z
    .string()
    .default("\n\n")
    .describe("Text inserted between old and new content in append/prepend mode."),
};
type UpdatePageArgs = z.infer<z.ZodObject<typeof updatePageShape>>;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerPageTools(server: McpServer): void {
  server.registerTool(
    "bookstack_list_pages",
    {
      title: "List BookStack pages",
      description: `List pages, optionally restricted to a book or a chapter.

Returns metadata only, never page bodies, so it is safe to call on large books. Read-only.

Args:
  - book_id (number): optional, restrict to one book
  - chapter_id (number): optional, restrict to one chapter
  - name_contains (string): optional case-insensitive substring filter on the title
  - count (number): items to return, 1-100 (default: 20)
  - offset (number): items to skip (default: 0)
  - sort (string): e.g. '-updated_at' for most recently edited first
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "total": number, "count": number, "offset": number,
    "has_more": boolean, "next_offset": number,
    "items": [{ "id": number, "name": string, "book_id": number, "chapter_id": number,
                "slug": string, "updated_at": string, "draft": boolean, "tags": string }]
  }

Examples:
  - Use when: "what have I edited most recently?" -> sort="-updated_at"
  - Use when: "list the pages in book 4" -> book_id=4
  - Don't use when: you need page content (use bookstack_get_page after finding the id)`,
      inputSchema: listPagesShape,
      outputSchema: { ...paginationOutputShape, items: z.array(z.object(pageSummaryShape)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ListPagesArgs) => {
      try {
        const filters: Record<string, string | number> = {};
        if (args.book_id !== undefined) filters["book_id"] = args.book_id;
        if (args.chapter_id !== undefined) filters["chapter_id"] = args.chapter_id;
        if (args.name_contains) filters["name:like"] = `%${args.name_contains}%`;

        const envelope = await fetchList<BookStackPage>("pages", {
          count: args.count,
          offset: args.offset,
          ...(args.sort ? { sort: args.sort } : {}),
          filters,
        });

        if (envelope.data.length === 0) {
          return toolSuccess(
            `No pages found for the given filters. Check the book_id or chapter_id with ` +
              `bookstack_get_book, or search the whole wiki with bookstack_search.`,
            { total: 0, count: 0, offset: args.offset, has_more: false, items: [] },
          );
        }

        const base = paginate(envelope.total, args.offset, envelope.data.map(toPageSummary));
        const { text, payload } = capListing(base, renderPages);

        return toolSuccess(
          args.response_format === "json" ? JSON.stringify(payload, null, 2) : text,
          payload,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "bookstack_get_page",
    {
      title: "Read a BookStack page",
      description: `Fetch one page's metadata and body.

Always read a page before updating it, so an append lands in the right place and a replace does not discard something worth keeping. Read-only.

Args:
  - page_id (number): id of the page
  - content_format ('markdown' | 'html' | 'none'): body representation (default: 'markdown')
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "id": number, "name": string, "book_id": number, "chapter_id": number,
    "slug": string, "created_at": string, "updated_at": string, "tags": string, "url": string,
    "content": string,            // omitted when content_format is 'none'
    "content_format": string,     // "markdown" | "html" | "none": what "content" actually holds
    "truncated": boolean          // true when the body exceeded the size limit
  }

Examples:
  - Use when: "show me the WireGuard notes" -> page_id from bookstack_search
  - Use when: you are about to append and need the current structure -> content_format="markdown"
  - Use when: you only need the title and tags -> content_format="none"

Error handling:
  - content_format="markdown" on a WYSIWYG-authored page returns HTML instead, with
    content_format="html" in the response. Append to such a page using the html argument.
  - Bodies over 25000 characters are truncated; the response says so.`,
      inputSchema: getPageShape,
      outputSchema: {
        ...pageSummaryShape,
        content: z.string().optional(),
        content_format: z.string(),
        truncated: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: GetPageArgs) => {
      try {
        const page = await apiRequest<BookStackPage>(`/pages/${args.page_id}`);
        const summary = await attachPageUrl(toPageSummary(page));

        let content: string | undefined;
        let actualFormat: "markdown" | "html" | "none" = "none";
        let truncated = false;

        if (args.content_format !== "none") {
          const markdown = page.markdown?.trim() ?? "";
          const html = page.html ?? "";
          if (args.content_format === "markdown" && markdown !== "") {
            actualFormat = "markdown";
            content = markdown;
          } else if (args.content_format === "markdown" && markdown === "" && html !== "") {
            actualFormat = "html";
            content = html;
          } else if (args.content_format === "html") {
            actualFormat = "html";
            content = html;
          }
          if (content !== undefined) {
            const capped = capText(
              content,
              "Read the page in the browser for the full body, or work section by section.",
            );
            content = capped.text;
            truncated = capped.truncated;
          }
        }

        const structured = {
          ...summary,
          content_format: actualFormat,
          ...(content !== undefined ? { content } : {}),
          ...(truncated ? { truncated } : {}),
        };

        const notice =
          args.content_format === "markdown" && actualFormat === "html"
            ? "\n_This page has no markdown source (authored in the WYSIWYG editor). " +
              "The body below is HTML; update it with the html argument, not markdown._\n"
            : "";

        const text = lines(
          renderSummary(summary, "#", [
            line("Book id", summary.book_id),
            line("Chapter id", summary.chapter_id),
          ]),
          notice,
          content !== undefined ? `## Content (${actualFormat})\n\n${content}` : undefined,
        );

        return toolSuccess(
          args.response_format === "json" ? JSON.stringify(structured, null, 2) : text,
          structured,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "bookstack_create_page",
    {
      title: "Create a BookStack page",
      description: `Create a new page in a book or chapter.

Before creating, check whether a suitable page already exists with bookstack_search: extending an existing page usually beats adding a near-duplicate. Requires a destination (book_id or chapter_id) and a body (markdown or html).

${AUTHORING_CONVENTIONS}

A leading heading matching the title is stripped automatically and the response says so; an unusable image reference is refused outright.

Args:
  - name (string): page title, 1-255 characters
  - book_id (number): destination book, required unless chapter_id is given
  - chapter_id (number): destination chapter, takes precedence over book_id
  - markdown (string): page body in markdown (preferred)
  - html (string): page body in HTML, as an alternative to markdown
  - tags (array): optional [{ "name": string, "value": string }]

Returns (json format):
  { "id": number, "name": string, "book_id": number, "chapter_id": number,
    "slug": string, "url": string, "created_at": string }

Examples:
  - Use when: "save this WireGuard config walkthrough to the Homelab book"
      -> book_id=4, name="WireGuard on Ubuntu", markdown="## Context\\n..."   (no "# WireGuard on Ubuntu")
  - Use when: capturing a decision from a coding session, tagged for later retrieval
      -> tags=[{"name":"source","value":"claude-session"}]
  - Don't use when: adding to an existing page (use bookstack_update_page with mode="append")

Error handling:
  - Returns an error naming the missing field if neither book_id nor chapter_id is given,
    or if neither markdown nor html carries content.
  - A 404 means the destination id does not exist; confirm with bookstack_get_book.`,
      inputSchema: createPageShape,
      outputSchema: pageSummaryShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreatePageArgs) => {
      try {
        if (args.book_id === undefined && args.chapter_id === undefined) {
          throw new BookStackError(
            "No destination was given for the new page.",
            undefined,
            "Pass book_id or chapter_id. Use bookstack_list_books or bookstack_get_book to find one.",
          );
        }
        const { content, stripped } = withoutDuplicateTitle(
          resolveContent(args.markdown, args.html, true),
          args.name,
        );

        const created = await apiRequest<BookStackPage>("/pages", {
          method: "POST",
          body: {
            name: args.name,
            ...(args.chapter_id !== undefined
              ? { chapter_id: args.chapter_id }
              : { book_id: args.book_id }),
            ...content,
            ...(args.tags ? { tags: args.tags } : {}),
          },
        });

        const summary = await attachPageUrl(toPageSummary(created));
        return toolSuccess(
          `Created page "${summary.name}" (page_id: ${summary.id}) in book ${summary.book_id}` +
            `${summary.chapter_id ? `, chapter ${summary.chapter_id}` : ""}.` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}` +
            `${stripped ? `\n${TITLE_STRIPPED_NOTICE}` : ""}`,
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "bookstack_update_page",
    {
      title: "Update a BookStack page",
      description: `Add to or rewrite an existing page.

Defaults to mode="append", which reads the current body and adds the new content at the end, so accumulating notes on a page never destroys earlier ones. mode="replace" overwrites the entire body and should be used only when the page is genuinely being rewritten.

${AUTHORING_CONVENTIONS}

The title rule applies to replace and prepend mode, where the content lands at the top of the page; such a heading is stripped automatically. The image rule applies in every mode.

Args:
  - page_id (number): id of the page to update
  - mode ('append' | 'prepend' | 'replace'): how to apply the content (default: 'append')
  - markdown (string): content to apply, in markdown
  - html (string): content to apply, in HTML (required for WYSIWYG-authored pages)
  - name (string): optional new title
  - tags (array): optional replacement tag set; omitting this leaves tags untouched
  - separator (string): text placed between old and new content (default: two newlines)

Returns (json format):
  { "id": number, "name": string, "book_id": number, "chapter_id": number,
    "slug": string, "url": string, "updated_at": string, "mode": string,
    "previous_length": number, "new_length": number }

Examples:
  - Use when: "add this fix to the existing Synology TLS page"
      -> page_id=31, markdown="### DNS-01 renewal\\n..."
  - Use when: "rewrite that page from scratch" -> mode="replace"
  - Use when: only retitling or retagging -> pass name and/or tags with no content

Error handling:
  - Appending markdown to a page with no markdown source returns an error telling you to
    resend the content as html; read the page first with bookstack_get_page to check.
  - Passing both markdown and html returns an error naming the conflict.`,
      inputSchema: updatePageShape,
      outputSchema: {
        ...pageSummaryShape,
        mode: z.string(),
        previous_length: z.number().optional(),
        new_length: z.number().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: UpdatePageArgs) => {
      try {
        const incoming = resolveContent(args.markdown, args.html, false);

        if (!incoming && args.name === undefined && args.tags === undefined) {
          throw new BookStackError(
            "Nothing to update.",
            undefined,
            "Provide markdown or html content, or a new name, or a tags array.",
          );
        }

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        if (args.tags !== undefined) body["tags"] = args.tags;

        let previousLength: number | undefined;
        let newLength: number | undefined;
        let stripped = false;

        if (incoming) {
          if (args.mode === "replace") {
            // The title is needed only to compare against a leading heading, so
            // the page is fetched only when there is one to compare.
            const title =
              args.name ??
              (startsWithTopHeading(incoming)
                ? (await apiRequest<BookStackPage>(`/pages/${args.page_id}`)).name
                : undefined);
            const cleaned = withoutDuplicateTitle(incoming, title);
            stripped = cleaned.stripped;
            Object.assign(body, cleaned.content);
            newLength = Object.values(cleaned.content)[0]?.length ?? 0;
          } else {
            const current = await apiRequest<BookStackPage>(`/pages/${args.page_id}`);
            const isMarkdown = "markdown" in incoming;
            const existing = isMarkdown ? (current.markdown ?? "") : (current.html ?? "");

            if (isMarkdown && existing.trim() === "" && (current.html ?? "").trim() !== "") {
              throw new BookStackError(
                `Page ${args.page_id} has no markdown source, so markdown cannot be appended to it.`,
                undefined,
                `This page was authored in the WYSIWYG editor. Resend the same content in the html ` +
                  `argument, or use mode="replace" to convert the page to markdown (this discards ` +
                  `the existing formatting, so read it first with bookstack_get_page).`,
              );
            }

            // Only a prepend puts the new content at the top, where a heading
            // repeating the title would double up with the one BookStack draws.
            const applied =
              args.mode === "prepend"
                ? withoutDuplicateTitle(incoming, args.name ?? current.name)
                : { content: incoming, stripped: false };
            stripped = applied.stripped;

            const addition = isMarkdown
              ? (applied.content as { markdown: string }).markdown
              : (applied.content as { html: string }).html;
            const merged =
              args.mode === "append"
                ? existing === ""
                  ? addition
                  : `${existing}${args.separator}${addition}`
                : existing === ""
                  ? addition
                  : `${addition}${args.separator}${existing}`;

            previousLength = existing.length;
            newLength = merged.length;
            body[isMarkdown ? "markdown" : "html"] = merged;
          }
        }

        const updated = await apiRequest<BookStackPage>(`/pages/${args.page_id}`, {
          method: "PUT",
          body,
        });

        const summary = await attachPageUrl(toPageSummary(updated));
        const structured = {
          ...summary,
          mode: args.mode,
          ...(previousLength !== undefined ? { previous_length: previousLength } : {}),
          ...(newLength !== undefined ? { new_length: newLength } : {}),
        };

        const change =
          previousLength !== undefined && newLength !== undefined
            ? ` Body went from ${previousLength} to ${newLength} characters.`
            : "";

        return toolSuccess(
          `Updated page "${summary.name}" (page_id: ${summary.id}) using mode="${args.mode}".${change}` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}` +
            `${stripped ? `\n${TITLE_STRIPPED_NOTICE}` : ""}`,
          structured,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
