/**
 * Shelf tools.
 *
 * A shelf groups books. The BookStack API expresses that grouping as a `books`
 * array on `PUT /api/shelves/{id}`, and that array REPLACES the whole set: send
 * one id and every other book silently drops off the shelf. `books_mode`
 * defaults to "add", which reads the current assignment first and sends the
 * union, so the common case cannot destroy the shelf by accident.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest } from "../services/client.js";
import { fetchList } from "../services/list.js";
import {
  summarizeDescribed,
  summarizeDescribedBrief,
  renderDescribedCollection,
  renderSummary,
} from "../services/entities.js";
import {
  capListing,
  line,
  lines,
  paginate,
  toolFailure,
  toolSuccess,
} from "../services/format.js";
import {
  describedSummaryShape,
  paginationOutputShape,
  paginationShape,
  responseFormatField,
  sortField,
  tagsField,
} from "../schemas/common.js";
import type { BookStackShelf } from "../types.js";

const shelfBookShape = {
  id: z.number(),
  name: z.string(),
  slug: z.string().optional(),
};

/* -------------------------------------------------------------------------- */
/* bookstack_list_shelves                                                      */
/* -------------------------------------------------------------------------- */

const listShelvesShape = {
  ...paginationShape,
  sort: sortField,
  response_format: responseFormatField,
};
type ListShelvesArgs = z.infer<z.ZodObject<typeof listShelvesShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_get_shelf                                                         */
/* -------------------------------------------------------------------------- */

const getShelfShape = {
  shelf_id: z.number().int().positive().describe("Id of the shelf, from bookstack_list_shelves."),
  response_format: responseFormatField,
};
type GetShelfArgs = z.infer<z.ZodObject<typeof getShelfShape>>;

/* -------------------------------------------------------------------------- */
/* bookstack_update_shelf                                                      */
/* -------------------------------------------------------------------------- */

const updateShelfShape = {
  shelf_id: z.number().int().positive().describe("Id of the shelf to update."),
  book_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe("Book ids to add, remove or set, depending on books_mode. Omit to leave books alone."),
  books_mode: z
    .enum(["add", "remove", "replace"])
    .default("add")
    .describe(
      "How book_ids is applied. 'add' (default) keeps the books already on the shelf and adds " +
        "these; 'remove' detaches these and keeps the rest; 'replace' makes the shelf contain " +
        "exactly these, detaching everything else. Prefer add unless you mean to reset the shelf.",
    ),
  name: z.string().min(1).max(255).optional().describe("New shelf name. Omit to keep the current one."),
  description: z.string().max(1900).optional().describe("New description. Omit to keep the current one."),
  tags: tagsField,
};
type UpdateShelfArgs = z.infer<z.ZodObject<typeof updateShelfShape>>;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerShelfTools(server: McpServer): void {
  server.registerTool(
    "bookstack_list_shelves",
    {
      title: "List BookStack shelves",
      description: `List the shelves that group books together.

Shelves are the coarsest level of organisation. Read-only. This listing does not include each shelf's books; use bookstack_get_shelf for that.

Args:
  - count (number): items to return, 1-100 (default: 20)
  - offset (number): items to skip (default: 0)
  - sort (string): e.g. '+name'
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "total": number, "count": number, "offset": number,
    "has_more": boolean, "next_offset": number,
    "items": [{ "id": number, "name": string, "slug": string,
                "description": string, "updated_at": string, "tags": string, "url": string }]
  }

Examples:
  - Use when: "how is the wiki organised at the top level?"
  - Don't use when: you need actual content (use bookstack_search)`,
      inputSchema: listShelvesShape,
      outputSchema: { ...paginationOutputShape, items: z.array(z.object(describedSummaryShape)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ListShelvesArgs) => {
      try {
        const envelope = await fetchList<BookStackShelf>("shelves", {
          count: args.count,
          offset: args.offset,
          ...(args.sort ? { sort: args.sort } : {}),
        });

        if (envelope.data.length === 0) {
          return toolSuccess("No shelves defined in this wiki. Books may exist without a shelf.", {
            total: 0,
            count: 0,
            offset: args.offset,
            has_more: false,
            items: [],
          });
        }

        const base = paginate(
          envelope.total,
          args.offset,
          envelope.data.map((shelf) => summarizeDescribedBrief(shelf, "shelves")),
        );
        const { text, payload } = capListing(base, (current) =>
          renderDescribedCollection("Shelves", current),
        );

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
    "bookstack_get_shelf",
    {
      title: "Get a BookStack shelf with its books",
      description: `Fetch one shelf's metadata plus the books assigned to it.

Read this before bookstack_update_shelf so you know what is currently on the shelf. Read-only.

Args:
  - shelf_id (number): id of the shelf
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "id": number, "name": string, "slug": string, "description": string,
    "created_at": string, "updated_at": string, "tags": string, "url": string,
    "books": [{ "id": number, "name": string, "slug": string }],
    "book_count": number
  }

Examples:
  - Use when: "which books are on the NAS shelf?" -> shelf_id=1
  - Use when: preparing a shelf update and needing the current book ids
  - Don't use when: you want the pages inside a book (use bookstack_get_book)

Error handling:
  - A 404 means no shelf carries that id. Shelf ids are their own sequence, separate
    from book ids; confirm with bookstack_list_shelves.`,
      inputSchema: getShelfShape,
      outputSchema: {
        ...describedSummaryShape,
        books: z.array(z.object(shelfBookShape)),
        book_count: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: GetShelfArgs) => {
      try {
        const shelf = await apiRequest<BookStackShelf>(`/shelves/${args.shelf_id}`);
        const summary = summarizeDescribed(shelf, "shelves");
        const books = (shelf.books ?? []).map((book) => ({
          id: book.id,
          name: book.name,
          ...(book.slug ? { slug: book.slug } : {}),
        }));

        const structured = { ...summary, books, book_count: books.length };

        const bookList =
          books.length === 0
            ? "_No books on this shelf yet. Attach one with bookstack_update_shelf._"
            : books.map((book) => `- "${book.name}" (book_id: ${book.id})`).join("\n");

        const text = lines(
          renderSummary(summary, "#", [line("Description", summary.description)]),
          "",
          `## Books (${books.length})`,
          bookList,
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
    "bookstack_update_shelf",
    {
      title: "Update a BookStack shelf",
      description: `Change a shelf's books, name, description or tags.

The main use is attaching a book to a shelf, which the BookStack API only exposes as a full replacement of the shelf's book list. This tool reads the current list first and merges, so books_mode="add" (the default) never detaches anything. Only books_mode="replace" removes books you did not name.

Args:
  - shelf_id (number): id of the shelf
  - book_ids (array of numbers): book ids to add, remove or set; omit to leave books untouched
  - books_mode ('add' | 'remove' | 'replace'): how book_ids applies (default: 'add')
  - name (string): optional new shelf name
  - description (string): optional new description
  - tags (array): optional replacement tag set

Returns (json format):
  {
    "id": number, "name": string, "slug": string, "url": string,
    "books": [{ "id": number, "name": string }],
    "book_count": number,
    "books_mode": string,
    "previous_book_ids": number[],   // the shelf's books before the change
    "added": number[],               // ids newly attached
    "removed": number[]              // ids detached
  }

Examples:
  - Use when: "put the Homelab book on the NAS shelf" -> shelf_id=1, book_ids=[4]
  - Use when: "this shelf should hold exactly books 2 and 5" -> books_mode="replace", book_ids=[2,5]
  - Use when: only renaming a shelf -> pass name with no book_ids
  - Don't use when: creating content (use bookstack_create_book or bookstack_create_page)

Error handling:
  - A 404 on the shelf means shelf_id is wrong; a 422 usually means one of book_ids
    does not exist. Confirm ids with bookstack_list_books.
  - Returns an error when nothing was supplied to change.`,
      inputSchema: updateShelfShape,
      outputSchema: {
        ...describedSummaryShape,
        books: z.array(z.object(shelfBookShape)),
        book_count: z.number(),
        books_mode: z.string(),
        previous_book_ids: z.array(z.number()).optional(),
        added: z.array(z.number()).optional(),
        removed: z.array(z.number()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: UpdateShelfArgs) => {
      try {
        if (
          args.book_ids === undefined &&
          args.name === undefined &&
          args.description === undefined &&
          args.tags === undefined
        ) {
          return toolFailure(
            new Error(
              "Nothing to update. Provide book_ids, or a new name, description or tags array.",
            ),
          );
        }

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        if (args.description !== undefined) body["description"] = args.description;
        if (args.tags !== undefined) body["tags"] = args.tags;

        let previousIds: number[] | undefined;
        let added: number[] = [];
        let removed: number[] = [];

        if (args.book_ids !== undefined) {
          const requested = [...new Set(args.book_ids)];

          if (args.books_mode === "replace") {
            body["books"] = requested;
          } else {
            const current = await apiRequest<BookStackShelf>(`/shelves/${args.shelf_id}`);
            previousIds = (current.books ?? []).map((book) => book.id);

            if (args.books_mode === "add") {
              added = requested.filter((id) => !previousIds?.includes(id));
              body["books"] = [...previousIds, ...added];
            } else {
              removed = previousIds.filter((id) => requested.includes(id));
              body["books"] = previousIds.filter((id) => !requested.includes(id));
            }
          }
        }

        const putResult = await apiRequest<BookStackShelf>(`/shelves/${args.shelf_id}`, {
          method: "PUT",
          body,
        });

        // BookStack omits the `books` relation from update responses, so reporting
        // straight from the PUT result would claim the shelf is empty. Re-read it
        // when the relation is missing rather than guessing at the new state.
        const updated =
          putResult.books === undefined
            ? await apiRequest<BookStackShelf>(`/shelves/${args.shelf_id}`)
            : putResult;

        const summary = summarizeDescribed(updated, "shelves");
        const books = (updated.books ?? []).map((book) => ({
          id: book.id,
          name: book.name,
          ...(book.slug ? { slug: book.slug } : {}),
        }));

        if (args.books_mode === "replace" && previousIds === undefined && args.book_ids) {
          added = args.book_ids;
        }

        const structured = {
          ...summary,
          books,
          book_count: books.length,
          books_mode: args.books_mode,
          ...(previousIds !== undefined ? { previous_book_ids: previousIds } : {}),
          ...(added.length > 0 ? { added } : {}),
          ...(removed.length > 0 ? { removed } : {}),
        };

        const changes: string[] = [];
        if (added.length > 0) changes.push(`attached book(s) ${added.join(", ")}`);
        if (removed.length > 0) changes.push(`detached book(s) ${removed.join(", ")}`);
        if (args.book_ids !== undefined && added.length === 0 && removed.length === 0) {
          changes.push("no change to the book set");
        }
        if (args.name !== undefined) changes.push("renamed");
        if (args.description !== undefined) changes.push("description updated");
        if (args.tags !== undefined) changes.push("tags replaced");

        return toolSuccess(
          `Updated shelf "${summary.name}" (shelf_id: ${summary.id}): ${changes.join(", ")}. ` +
            `It now holds ${books.length} book(s).` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}`,
          structured,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
