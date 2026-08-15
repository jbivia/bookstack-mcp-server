/**
 * High-level capture workflow.
 *
 * The common case for this server is "write down what we just worked out"
 * mid-session. Doing that with the primitive tools takes four or five calls
 * (list books, maybe create one, list pages, read the page, update it). This
 * tool collapses it into one, addressing the destination by name rather than by
 * id, and never overwrites existing content.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest } from "../services/client.js";
import { fetchList } from "../services/list.js";
import { summarize } from "../services/entities.js";
import { buildPageUrl, rememberBookSlug } from "../services/links.js";
import { toolFailure, toolSuccess } from "../services/format.js";
import { AUTHORING_CONVENTIONS, assertNoUnusableImages } from "../services/authoring.js";
import { withoutDuplicateTitle } from "../services/title.js";
import { tagsField } from "../schemas/common.js";
import type { BookStackBook, BookStackChapter, BookStackPage } from "../types.js";

const inputShape = {
  book: z
    .string()
    .min(1)
    .max(255)
    .describe(
      "Name of the destination book. Matched case-insensitively against existing books; " +
        "created if no match is found and create_missing is true.",
    ),
  chapter: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Optional chapter name inside the book. Created if missing."),
  title: z.string().min(1).max(255).describe("Page title. An existing page with this title is reused."),
  markdown: z
    .string()
    .min(1)
    .describe(
      "Note content in markdown, the expected format for this wiki. Images cannot be uploaded; " +
        "use ASCII art in a fenced code block for diagrams. Do not repeat `title` as a level-1 " +
        "heading — BookStack renders it already.",
    ),
  heading: z
    .string()
    .max(255)
    .optional()
    .describe(
      "Optional section heading inserted above the content when appending to an existing page, " +
        "e.g. 'DNS-01 renewal'. Rendered as a level-2 markdown heading.",
    ),
  tags: tagsField,
  create_missing: z
    .boolean()
    .default(true)
    .describe(
      "Whether to create the book and chapter when they do not exist. Set false to fail loudly " +
        "instead, when the note must land somewhere that already exists.",
    ),
};

type SaveNoteArgs = z.infer<z.ZodObject<typeof inputShape>>;

const outputShape = {
  page_id: z.number(),
  page_name: z.string(),
  book_id: z.number(),
  book_name: z.string(),
  chapter_id: z.number().optional(),
  chapter_name: z.string().optional(),
  action: z.string().describe("'created_page' or 'appended_to_page'."),
  created: z.array(z.string()).describe("Containers created along the way, e.g. ['book','chapter']."),
  url: z.string().optional(),
};

/** Case-insensitive exact-name match, falling back to the first LIKE hit. */
function pickByName<T extends { name: string }>(candidates: T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    candidates.find((candidate) => candidate.name.trim().toLowerCase() === wanted) ?? candidates[0]
  );
}

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    "bookstack_save_note",
    {
      title: "Save a note to the wiki",
      description: `Capture a note into the wiki in one call, addressing the destination by name.

Finds the book (and optional chapter) by name, creating them when needed, then either creates the page or appends to it if a page with that title already exists. Existing content is never overwritten: repeated calls with the same title accumulate sections on one page. Use this for capturing decisions, configuration snippets or conclusions from a working session. For precise edits to a known page, use bookstack_update_page instead.

${AUTHORING_CONVENTIONS}

Args:
  - book (string): destination book name, matched case-insensitively
  - chapter (string): optional chapter name inside that book
  - title (string): page title; an existing page with this title is reused
  - markdown (string): the note content
  - heading (string): optional section heading, added above the content when appending
  - tags (array): optional [{ "name": string, "value": string }], applied on page creation
  - create_missing (boolean): create the book/chapter when absent (default: true)

Returns (json format):
  {
    "page_id": number, "page_name": string,
    "book_id": number, "book_name": string,
    "chapter_id": number, "chapter_name": string,
    "action": string,           // "created_page" | "appended_to_page"
    "created": string[],        // containers created, e.g. ["book"]
    "url": string
  }

Examples:
  - Use when: "note this acme.sh DNS-01 setup in the wiki"
      -> book="Homelab", title="Synology TLS", markdown="...", heading="acme.sh DNS-01"
  - Use when: appending a second finding to the same page later in a session (same title)
  - Don't use when: the target page must not gain a new section (use bookstack_update_page
    with mode="replace"), or when the page was authored in the WYSIWYG editor

Error handling:
  - With create_missing=false, a missing book returns an error listing the closest names.
  - Appending to a page with no markdown source returns an error suggesting
    bookstack_update_page with the html argument.`,
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: SaveNoteArgs) => {
      const created: string[] = [];
      try {
        /* 0. Refuse content that cannot render before creating containers for it. */
        assertNoUnusableImages({ markdown: args.markdown });

        /* 1. Resolve the book. */
        const bookMatches = await fetchList<BookStackBook>("books", {
          count: 10,
          offset: 0,
          filters: { "name:like": `%${args.book}%` },
        });
        let book = pickByName(bookMatches.data, args.book);

        if (!book) {
          if (!args.create_missing) {
            const all = await fetchList<BookStackBook>("books", { count: 20, offset: 0 });
            const names = all.data.map((item) => `"${item.name}"`).join(", ") || "none";
            return toolFailure(
              new Error(
                `No book named "${args.book}" exists and create_missing is false. Existing books: ${names}.`,
              ),
            );
          }
          book = await apiRequest<BookStackBook>("/books", {
            method: "POST",
            body: { name: args.book },
          });
          created.push("book");
        }

        /* 2. Resolve the chapter, when one was asked for. */
        let chapter: BookStackChapter | undefined;
        if (args.chapter) {
          const chapterMatches = await fetchList<BookStackChapter>("chapters", {
            count: 10,
            offset: 0,
            filters: { book_id: book.id, "name:like": `%${args.chapter}%` },
          });
          chapter = pickByName(chapterMatches.data, args.chapter);

          if (!chapter) {
            if (!args.create_missing) {
              return toolFailure(
                new Error(
                  `No chapter named "${args.chapter}" in book "${book.name}" and create_missing is false.`,
                ),
              );
            }
            chapter = await apiRequest<BookStackChapter>("/chapters", {
              method: "POST",
              body: { book_id: book.id, name: args.chapter },
            });
            created.push("chapter");
          }
        }

        /* 3. Find an existing page with this title in the destination. */
        const pageFilters: Record<string, string | number> = { "name:like": args.title };
        if (chapter) pageFilters["chapter_id"] = chapter.id;
        else pageFilters["book_id"] = book.id;

        const pageMatches = await fetchList<BookStackPage>("pages", {
          count: 10,
          offset: 0,
          filters: pageFilters,
        });
        const existing = pageMatches.data.find(
          (page) => page.name.trim().toLowerCase() === args.title.trim().toLowerCase(),
        );

        const section = args.heading ? `## ${args.heading}\n\n${args.markdown}` : args.markdown;

        /* 4a. Append to the existing page. */
        if (existing) {
          const current = await apiRequest<BookStackPage>(`/pages/${existing.id}`);
          const currentMarkdown = current.markdown ?? "";

          if (currentMarkdown.trim() === "" && (current.html ?? "").trim() !== "") {
            return toolFailure(
              new Error(
                `Page "${existing.name}" (page_id: ${existing.id}) has no markdown source, so this ` +
                  `note cannot be appended as markdown. It was authored in the WYSIWYG editor: use ` +
                  `bookstack_update_page with the html argument instead.`,
              ),
            );
          }

          const merged =
            currentMarkdown.trim() === "" ? section : `${currentMarkdown}\n\n${section}`;
          const updated = await apiRequest<BookStackPage>(`/pages/${existing.id}`, {
            method: "PUT",
            body: { markdown: merged },
          });

          const summary = summarize(updated);
          const pageLink = (await buildPageUrl(book.id, updated.slug)) ?? summary.url;
          const structured = {
            page_id: updated.id,
            page_name: updated.name,
            book_id: book.id,
            book_name: book.name,
            ...(chapter ? { chapter_id: chapter.id, chapter_name: chapter.name } : {}),
            action: "appended_to_page",
            created,
            ...(pageLink ? { url: pageLink } : {}),
          };

          return toolSuccess(
            `Appended to existing page "${updated.name}" (page_id: ${updated.id}) in book ` +
              `"${book.name}"${chapter ? `, chapter "${chapter.name}"` : ""}.` +
              `${created.length > 0 ? ` Created: ${created.join(", ")}.` : ""}` +
              `${pageLink ? `\nURL: ${pageLink}` : ""}`,
            structured,
          );
        }

        /* 4b. Or create a new page, minus any heading that just repeats the title. */
        const body = withoutDuplicateTitle({ markdown: section }, args.title).content;
        const page = await apiRequest<BookStackPage>("/pages", {
          method: "POST",
          body: {
            name: args.title,
            ...(chapter ? { chapter_id: chapter.id } : { book_id: book.id }),
            ...body,
            ...(args.tags ? { tags: args.tags } : {}),
          },
        });

        const summary = summarize(page);
        const pageLink = (await buildPageUrl(book.id, page.slug)) ?? summary.url;
        const structured = {
          page_id: page.id,
          page_name: page.name,
          book_id: book.id,
          book_name: book.name,
          ...(chapter ? { chapter_id: chapter.id, chapter_name: chapter.name } : {}),
          action: "created_page",
          created,
          ...(pageLink ? { url: pageLink } : {}),
        };

        return toolSuccess(
          `Created page "${page.name}" (page_id: ${page.id}) in book "${book.name}"` +
            `${chapter ? `, chapter "${chapter.name}"` : ""}.` +
            `${created.length > 0 ? ` Created: ${created.join(", ")}.` : ""}` +
            `${pageLink ? `\nURL: ${pageLink}` : ""}`,
          structured,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
