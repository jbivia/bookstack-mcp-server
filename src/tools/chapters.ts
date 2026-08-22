/**
 * Chapter tools. Chapters are optional groupings inside a book; a page can live
 * directly in a book or inside a chapter.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest } from "../services/client.js";
import { fetchList } from "../services/list.js";
import { summarize, renderSummary, type EntitySummary } from "../services/entities.js";
import { buildChapterUrl } from "../services/links.js";
import {
  capListing,
  line,
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
import type { BookStackChapter } from "../types.js";

interface ChapterSummary extends EntitySummary {
  book_id: number;
  description?: string;
}

const chapterSummaryShape = {
  ...entitySummaryShape,
  book_id: z.number().describe("Id of the book this chapter belongs to."),
  description: z.string().optional(),
};

function toChapterSummary(chapter: BookStackChapter): ChapterSummary {
  const description = chapter.description?.trim();
  return {
    ...summarize(chapter),
    book_id: chapter.book_id,
    ...(description ? { description: description.slice(0, 300) } : {}),
  };
}

/**
 * Add a `url` to a chapter summary when the API did not supply one.
 *
 * BookStack omits `url` on create and update responses, and a chapter link needs
 * the book slug, which only a second request resolves. Single-chapter operations
 * pay that cost; listings deliberately do not.
 */
async function withChapterUrl(summary: ChapterSummary): Promise<ChapterSummary> {
  if (summary.url) return summary;
  const url = await buildChapterUrl(summary.book_id, summary.slug);
  return url ? { ...summary, url } : summary;
}

function render(payload: Paginated<ChapterSummary>): string {
  const header = `# Chapters\n\n${payload.total} total, showing ${payload.count}.\n`;
  const blocks = payload.items.map((item) =>
    renderSummary(item, "##", [
      line("Book id", item.book_id),
      line("Description", item.description),
    ]),
  );
  return `${header}\n${blocks.join("\n\n")}${paginationFooter(payload)}`;
}

const listChaptersShape = {
  ...paginationShape,
  book_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Restrict to chapters inside this book. Omit to list chapters wiki-wide."),
  name_contains: z.string().optional().describe("Case-insensitive substring filter on the chapter name."),
  sort: sortField,
  response_format: responseFormatField,
};
type ListChaptersArgs = z.infer<z.ZodObject<typeof listChaptersShape>>;

const createChapterShape = {
  book_id: z.number().int().positive().describe("Id of the book that will contain the chapter."),
  name: z.string().min(1, "Name is required").max(255).describe("Title of the new chapter."),
  description: z.string().max(1900).optional().describe("Optional plain-text description."),
  tags: tagsField,
};
type CreateChapterArgs = z.infer<z.ZodObject<typeof createChapterShape>>;

const updateChapterShape = {
  chapter_id: z.number().int().positive().describe("Id of the chapter to update."),
  name: z.string().min(1).max(255).optional().describe("New name. Omit to keep the current one."),
  description: z
    .string()
    .max(1900)
    .optional()
    .describe("New plain-text description, replacing the previous one. An empty string clears it."),
  tags: tagsField,
  book_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Move the chapter, with every page it holds, into this book. Omit to leave it where it is.",
    ),
};
type UpdateChapterArgs = z.infer<z.ZodObject<typeof updateChapterShape>>;

export function registerChapterTools(server: McpServer): void {
  server.registerTool(
    "bookstack_list_chapters",
    {
      title: "List BookStack chapters",
      description: `List chapters, optionally restricted to a single book.

bookstack_get_book already returns a book's chapters inline, so prefer that when you have a book_id. This tool is for wiki-wide chapter lookups. Read-only.

Args:
  - book_id (number): optional, restrict to one book
  - name_contains (string): optional case-insensitive substring filter on the name
  - count (number): items to return, 1-100 (default: 20)
  - offset (number): items to skip (default: 0)
  - sort (string): e.g. '-updated_at'
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "total": number, "count": number, "offset": number,
    "has_more": boolean, "next_offset": number,
    "items": [{ "id": number, "name": string, "book_id": number, "slug": string,
                "description": string, "updated_at": string, "tags": string }]
  }

Examples:
  - Use when: "is there a chapter about TLS anywhere?" -> name_contains="tls"
  - Don't use when: you already called bookstack_get_book for that book`,
      inputSchema: listChaptersShape,
      outputSchema: { ...paginationOutputShape, items: z.array(z.object(chapterSummaryShape)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ListChaptersArgs) => {
      try {
        const filters: Record<string, string | number> = {};
        if (args.book_id !== undefined) filters["book_id"] = args.book_id;
        if (args.name_contains) filters["name:like"] = `%${args.name_contains}%`;

        const envelope = await fetchList<BookStackChapter>("chapters", {
          count: args.count,
          offset: args.offset,
          ...(args.sort ? { sort: args.sort } : {}),
          filters,
        });

        if (envelope.data.length === 0) {
          return toolSuccess(
            `No chapters found${args.book_id ? ` in book ${args.book_id}` : ""}. ` +
              `Pages can live directly in a book without any chapter.`,
            { total: 0, count: 0, offset: args.offset, has_more: false, items: [] },
          );
        }

        const base = paginate(envelope.total, args.offset, envelope.data.map(toChapterSummary));
        const { text, payload } = capListing(base, render);

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
    "bookstack_create_chapter",
    {
      title: "Create a BookStack chapter",
      description: `Create a chapter inside an existing book.

Chapters are optional: a book with a handful of pages does not need them. Create one when a book has grown enough that its pages need grouping.

Args:
  - book_id (number): id of the parent book
  - name (string): title of the chapter, 1-255 characters
  - description (string): optional plain-text description
  - tags (array): optional [{ "name": string, "value": string }]

Returns (json format):
  { "id": number, "name": string, "book_id": number, "slug": string, "url": string }

Examples:
  - Use when: "group the NAS pages under a Synology chapter" -> book_id=4, name="Synology"
  - Don't use when: the book has few pages (put pages directly in the book)

Error handling:
  - A 404 means book_id does not exist; confirm it with bookstack_list_books.`,
      inputSchema: createChapterShape,
      outputSchema: chapterSummaryShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateChapterArgs) => {
      try {
        const created = await apiRequest<BookStackChapter>("/chapters", {
          method: "POST",
          body: {
            book_id: args.book_id,
            name: args.name,
            ...(args.description ? { description: args.description } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
          },
        });
        const summary = await withChapterUrl(toChapterSummary(created));
        return toolSuccess(
          `Created chapter "${summary.name}" (chapter_id: ${summary.id}) in book ${summary.book_id}.\n` +
            `Add pages with bookstack_create_page using chapter_id=${summary.id}.` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}`,
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "bookstack_update_chapter",
    {
      title: "Update a BookStack chapter",
      description: `Change a chapter's name, description or tags, or move it to another book.

Metadata only: this never touches the pages inside the chapter, except that moving the chapter carries them along into the destination book. Each field is a whole-value replacement — the description you send replaces the previous one, and sending tags replaces the entire tag set, so read the chapter first with bookstack_list_chapters or bookstack_get_book when you mean to keep what is already there. Renaming a chapter changes its slug, and therefore its URL.

Args:
  - chapter_id (number): id of the chapter to update
  - name (string): optional new name, 1-255 characters
  - description (string): optional new description, up to 1900 characters; an empty string clears it
  - tags (array): optional replacement tag set [{ "name": string, "value": string }]; omit to leave tags untouched
  - book_id (number): optional destination book, moves the chapter and its pages there

Returns (json format):
  {
    "id": number, "name": string, "book_id": number, "slug": string,
    "description": string, "updated_at": string, "tags": string, "url": string,
    "changed": string[]   // what this call changed, e.g. ["renamed", "moved to book 7"]
  }

Examples:
  - Use when: "rename chapter 12 to Synology" -> chapter_id=12, name="Synology"
  - Use when: "that chapter belongs in the Homelab book" -> chapter_id=12, book_id=7
  - Don't use when: moving a single page (use bookstack_update_page with chapter_id)
  - Don't use when: changing the text of a page (use bookstack_update_page)

Error handling:
  - Returns an error when nothing was supplied to change.
  - A 404 means no chapter carries that id, or the destination book_id does not exist;
    confirm with bookstack_list_chapters and bookstack_list_books.
  - A 422 usually means the description exceeded 1900 characters, or the name was empty.`,
      inputSchema: updateChapterShape,
      outputSchema: {
        ...chapterSummaryShape,
        changed: z
          .array(z.string())
          .describe("What this call changed, e.g. ['renamed', 'moved to book 7']."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: UpdateChapterArgs) => {
      try {
        if (
          args.name === undefined &&
          args.description === undefined &&
          args.tags === undefined &&
          args.book_id === undefined
        ) {
          return toolFailure(
            new Error(
              "Nothing to update. Provide a new name, description, tags array, or a book_id to move the chapter.",
            ),
          );
        }

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        if (args.description !== undefined) body["description"] = args.description;
        if (args.tags !== undefined) body["tags"] = args.tags;
        if (args.book_id !== undefined) body["book_id"] = args.book_id;

        const updated = await apiRequest<BookStackChapter>(`/chapters/${args.chapter_id}`, {
          method: "PUT",
          body,
        });
        const summary = await withChapterUrl(toChapterSummary(updated));

        // Never empty: the guard above rejects a call that changes nothing.
        const changed: string[] = [];
        if (args.name !== undefined) changed.push("renamed");
        if (args.description !== undefined) {
          changed.push(args.description === "" ? "description cleared" : "description updated");
        }
        if (args.tags !== undefined) {
          changed.push(args.tags.length === 0 ? "tags cleared" : "tags replaced");
        }
        if (args.book_id !== undefined) changed.push(`moved to book ${summary.book_id}`);

        return toolSuccess(
          `Updated chapter "${summary.name}" (chapter_id: ${summary.id}): ${changed.join(", ")}.` +
            `${args.name !== undefined ? "\nThe rename changed the chapter's slug, so URLs noted earlier for it are stale." : ""}` +
            `${args.book_id !== undefined ? "\nThe pages it holds moved with it, and their URLs changed with the book." : ""}` +
            `${summary.url ? `\nURL: ${summary.url}` : ""}`,
          { ...summary, changed },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
