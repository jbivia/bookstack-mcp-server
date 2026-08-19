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
    .max(1900)
    .optional()
    .describe("Plain-text description shown on the book's cover."),
  tags: tagsField,
};
type CreateBookArgs = z.infer<z.ZodObject<typeof createBookShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_update_book                                                       */
/* -------------------------------------------------------------------------- */

const updateBookShape = {
  book_id: z.number().int().positive().describe("Id of the book to update."),
  name: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("New title. Omit to keep the current one. A rename also changes the book's slug."),
  // BookStack validates the plain-text description at max:1900; the 2000 bound
  // belongs to description_html, which this server does not expose.
  description: z
    .string()
    .max(1900)
    .optional()
    .describe(
      "New plain-text description, replacing the current one. Omit to leave it alone; " +
        "pass an empty string to clear it.",
    ),
  tags: tagsField,
};
type UpdateBookArgs = z.infer<z.ZodObject<typeof updateBookShape>>;

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

  server.registerTool(
    "bookstack_update_book",
    {
      title: "Update a BookStack book",
      description: `Change a book's name, description or tags.

Metadata only: this never touches the chapters and pages inside the book. Each field is a whole-value replacement — the description you send replaces the previous one, and sending tags replaces the entire tag set, so read the book first with bookstack_get_book when you mean to keep what is already there. Renaming a book changes its slug, and therefore its URL and the URL of every page it holds.

Args:
  - book_id (number): id of the book to update
  - name (string): optional new title, 1-255 characters
  - description (string): optional new description, up to 1900 characters; an empty string clears it
  - tags (array): optional replacement tag set [{ "name": string, "value": string }]; omit to leave tags untouched

Returns (json format):
  {
    "id": number, "name": string, "slug": string, "description": string,
    "created_at": string, "updated_at": string, "tags": string, "url": string,
    "changed": string[]   // what this call changed, e.g. ["renamed", "tags replaced"]
  }

Examples:
  - Use when: "rename book 4 to Homelab" -> book_id=4, name="Homelab"
  - Use when: "say on the cover what the Infrastructure book covers" -> book_id=4, description="..."
  - Use when: tagging a book for later retrieval -> tags=[{"name":"owner","value":"ops"}]
  - Don't use when: changing the text of a page (use bookstack_update_page)
  - Don't use when: attaching the book to a shelf (use bookstack_update_shelf)
  - Don't use when: no book fits yet and you need a new one (use bookstack_create_book)

Error handling:
  - Returns an error when nothing was supplied to change.
  - A 404 means no book carries that id. Book ids and page ids are separate sequences;
    confirm with bookstack_list_books.
  - A 422 usually means the description exceeded 1900 characters, or the name was empty.`,
      inputSchema: updateBookShape,
      outputSchema: {
        ...describedSummaryShape,
        changed: z
          .array(z.string())
          .describe("What this call changed, e.g. ['renamed', 'tags replaced']."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: UpdateBookArgs) => {
      try {
        if (args.name === undefined && args.description === undefined && args.tags === undefined) {
          return toolFailure(
            new Error("Nothing to update. Provide a new name, description or tags array."),
          );
        }

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        if (args.description !== undefined) body["description"] = args.description;
        if (args.tags !== undefined) body["tags"] = args.tags;

        const updated = await apiRequest<BookStackBook>(`/books/${args.book_id}`, {
          method: "PUT",
          body,
        });

        // Unlike a shelf update, this response carries every field the tool can
        // change, so nothing needs re-reading. It also carries the refreshed
        // slug: seeding the cache here is what keeps page URLs alive after a
        // rename, since resolveBookSlug would otherwise serve the old slug for
        // the rest of its TTL.
        rememberBookSlug(updated.id, updated.slug);
        const summary = summarizeDescribed(updated, "books");

        // Never empty: the guard above rejects a call that changes nothing.
        const changed: string[] = [];
        if (args.name !== undefined) changed.push("renamed");
        if (args.description !== undefined) {
          changed.push(args.description === "" ? "description cleared" : "description updated");
        }
        if (args.tags !== undefined) {
          changed.push(args.tags.length === 0 ? "tags cleared" : "tags replaced");
        }

        return toolSuccess(
          `Updated book "${summary.name}" (book_id: ${summary.id}): ${changed.join(", ")}.` +
            `${args.name !== undefined ? "\nThe rename changed the book's slug, so URLs noted earlier for this book or its pages are stale." : ""}` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}`,
          { ...summary, changed },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
