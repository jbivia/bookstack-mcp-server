/**
 * Book tools. Books are the top-level container an agent picks before
 * writing anything, so `bookstack_get_book` doubles as the navigation tool: it
 * returns the full chapter/page tree with the ids needed by the page tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest } from "../services/client.js";
import { fetchList } from "../services/list.js";
import { rememberBookSlug } from "../services/links.js";
import {
  summarizeDescribed,
  renderDescribedCollection,
  renderSummary,
} from "../services/entities.js";
import { capListing, line, lines, paginate, toolFailure, toolSuccess } from "../services/format.js";
import {
  describedSummaryShape,
  paginationOutputShape,
  paginationShape,
  responseFormatField,
  sortField,
  tagsField,
} from "../schemas/common.js";
import type { BookStackBook, BookStackBookContentItem } from "../types.js";

/* -------------------------------------------------------------------------- */
/* Shared rendering                                                            */
/* -------------------------------------------------------------------------- */

/** Flatten the `contents` tree of a book into an indented markdown outline. */
function renderContents(contents: BookStackBookContentItem[] | undefined): string {
  if (!contents || contents.length === 0) {
    return "_This book is empty. Create the first page with bookstack_create_page._";
  }
  const out: string[] = [];
  for (const item of contents) {
    if (item.type === "chapter") {
      out.push(`- **Chapter** "${item.name}" (chapter_id: ${item.id})`);
      for (const page of item.pages ?? []) {
        out.push(`  - Page "${page.name}" (page_id: ${page.id})${page.draft ? " _[draft]_" : ""}`);
      }
    } else {
      out.push(`- Page "${item.name}" (page_id: ${item.id})${item.draft ? " _[draft]_" : ""}`);
    }
  }
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/* bookstack_list_books                                                        */
/* -------------------------------------------------------------------------- */

const listBooksShape = {
  ...paginationShape,
  name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring filter on the book name, e.g. 'infra'."),
  sort: sortField,
  response_format: responseFormatField,
};
type ListBooksArgs = z.infer<z.ZodObject<typeof listBooksShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_get_book                                                          */
/* -------------------------------------------------------------------------- */

const getBookShape = {
  book_id: z.number().int().positive().describe("Id of the book, as returned by a listing or search."),
  response_format: responseFormatField,
};
type GetBookArgs = z.infer<z.ZodObject<typeof getBookShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_create_book                                                       */
/* -------------------------------------------------------------------------- */

const createBookShape = {
  name: z.string().min(1, "Name is required").max(255).describe("Title of the new book."),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("Plain-text description shown on the book's cover."),
  tags: tagsField,
};
type CreateBookArgs = z.infer<z.ZodObject<typeof createBookShape>>;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerBookTools(server: McpServer): void {
  server.registerTool(
    "bookstack_list_books",
    {
      title: "List BookStack books",
      description: `List the books (top-level containers) in the BookStack wiki.

Use this to discover where content lives before reading or writing. Read-only.

Args:
  - count (number): items to return, 1-100 (default: 20)
  - offset (number): items to skip, for pagination (default: 0)
  - name_contains (string): case-insensitive substring filter on the book name
  - sort (string): e.g. '-updated_at' for most recently changed first
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "total": number, "count": number, "offset": number,
    "has_more": boolean, "next_offset": number,
    "items": [{ "id": number, "name": string, "slug": string,
                "description": string, "created_at": string, "updated_at": string,
                "tags": string, "url": string }]
  }

Examples:
  - Use when: "what's in the wiki?" -> no arguments
  - Use when: "which book covers the NAS?" -> name_contains="nas"
  - Don't use when: you want to find specific content (use bookstack_search)`,
      inputSchema: listBooksShape,
      outputSchema: { ...paginationOutputShape, items: z.array(z.object(describedSummaryShape)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ListBooksArgs) => {
      try {
        const envelope = await fetchList<BookStackBook>("books", {
          count: args.count,
          offset: args.offset,
          ...(args.sort ? { sort: args.sort } : {}),
          ...(args.name_contains ? { filters: { "name:like": `%${args.name_contains}%` } } : {}),
        });

        if (envelope.data.length === 0) {
          const suffix = args.name_contains
            ? ` matching '${args.name_contains}'. Try a shorter fragment or omit the filter.`
            : `. The wiki has no books yet; create one with bookstack_create_book.`;
          return toolSuccess(`No books found${suffix}`, {
            total: 0,
            count: 0,
            offset: args.offset,
            has_more: false,
            items: [],
          });
        }

        for (const book of envelope.data) rememberBookSlug(book.id, book.slug);

        const base = paginate(
          envelope.total,
          args.offset,
          envelope.data.map((book) => summarizeDescribed(book, "books")),
        );
        const { text, payload } = capListing(base, (current) => renderDescribedCollection("Books", current));

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
    "bookstack_get_book",
    {
      title: "Get a BookStack book with its contents",
      description: `Fetch one book's metadata plus its full chapter and page tree.

This is the navigation tool: the returned outline gives the chapter_id and page_id values needed by bookstack_get_page, bookstack_create_page and bookstack_update_page. Read-only.

Args:
  - book_id (number): id of the book
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "id": number, "name": string, "slug": string, "description": string,
    "created_at": string, "updated_at": string, "tags": string, "url": string,
    "contents": [
      { "type": "chapter", "id": number, "name": string,
        "pages": [{ "id": number, "name": string, "draft": boolean }] },
      { "type": "page", "id": number, "name": string, "draft": boolean }
    ]
  }

Examples:
  - Use when: "list everything in the Infrastructure book" -> book_id=4
  - Use when: you need a chapter_id before creating a page in the right place
  - Don't use when: you only need the page body (use bookstack_get_page)

Error handling:
  - A 404 means no book carries that id. Book ids and page ids are separate sequences;
    use bookstack_list_books to get the right one.`,
      inputSchema: getBookShape,
      outputSchema: {
        ...describedSummaryShape,
        contents: z.array(z.record(z.unknown())).describe("Ordered chapter/page tree."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: GetBookArgs) => {
      try {
        const book = await apiRequest<BookStackBook>(`/books/${args.book_id}`);
        rememberBookSlug(book.id, book.slug);
        const summary = summarizeDescribed(book, "books");
        const contents = (book.contents ?? []).map((item) => ({
          type: item.type,
          id: item.id,
          name: item.name,
          ...(item.draft !== undefined ? { draft: item.draft } : {}),
          ...(item.type === "chapter"
            ? {
                pages: (item.pages ?? []).map((page) => ({
                  id: page.id,
                  name: page.name,
                  ...(page.draft !== undefined ? { draft: page.draft } : {}),
                })),
              }
            : {}),
        }));

        const structured = { ...summary, contents };
        const text = lines(
          renderSummary(summary, "#", [line("Description", summary.description)]),
          "",
          "## Contents",
          renderContents(book.contents),
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
    "bookstack_create_book",
    {
      title: "Create a BookStack book",
      description: `Create a new top-level book in the wiki.

Only use this when no existing book fits: check bookstack_list_books first, since a sprawl of near-duplicate books makes the wiki harder to search. This tool creates a container only; add content with bookstack_create_page.

Args:
  - name (string): title of the book, 1-255 characters
  - description (string): optional plain-text description
  - tags (array): optional [{ "name": string, "value": string }]

Returns (json format):
  { "id": number, "name": string, "slug": string, "url": string, "created_at": string }

Examples:
  - Use when: "start a book for my homelab notes" -> name="Homelab"
  - Don't use when: an existing book already covers the topic (create a chapter or page instead)

Error handling:
  - A 403 means the token's role lacks book-create permission.`,
      inputSchema: createBookShape,
      outputSchema: describedSummaryShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateBookArgs) => {
      try {
        const created = await apiRequest<BookStackBook>("/books", {
          method: "POST",
          body: {
            name: args.name,
            ...(args.description ? { description: args.description } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
          },
        });
        rememberBookSlug(created.id, created.slug);
        const summary = summarizeDescribed(created, "books");
        return toolSuccess(
          `Created book "${summary.name}" (book_id: ${summary.id}).\n` +
            `Add content with bookstack_create_page using book_id=${summary.id}.`,
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
