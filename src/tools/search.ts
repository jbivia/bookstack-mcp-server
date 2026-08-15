/**
 * Cross-content search. This is the primary discovery tool: an agent should
 * reach for it before any listing tool when it knows what it is looking for.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apiRequest } from "../services/client.js";
import { summarize } from "../services/entities.js";
import {
  capListing,
  lines,
  line,
  paginate,
  paginationFooter,
  stripHtml,
  toolFailure,
  toolSuccess,
  type Paginated,
} from "../services/format.js";
import { entitySummaryShape, paginationOutputShape, responseFormatField } from "../schemas/common.js";
import { DEFAULT_COUNT, MAX_COUNT } from "../constants.js";
import type { BookStackSearchResult, ListEnvelope } from "../types.js";

const inputShape = {
  query: z
    .string()
    .min(1, "Query must not be empty")
    .max(300, "Query must not exceed 300 characters")
    .describe(
      "Search terms. Supports BookStack search syntax: \"exact phrase\" for exact matches, " +
        "{type:page} to restrict to one content type (page, chapter, book, bookshelf), " +
        "[tagname=value] to match a tag, {in_name:term} to match the title only, " +
        "{updated_after:2026-01-01} for a date filter. Example: 'symfony {type:page} [project=nivel]'.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_COUNT)
    .default(DEFAULT_COUNT)
    .describe(`Results per page (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("1-based page number. Search paginates by page, not by offset."),
  response_format: responseFormatField,
};

type SearchArgs = z.infer<z.ZodObject<typeof inputShape>>;

const searchItemShape = {
  ...entitySummaryShape,
  type: z.string().describe("Content type: 'page', 'chapter', 'book' or 'bookshelf'."),
  book_id: z.number().optional().describe("Parent book id, for pages and chapters."),
  chapter_id: z.number().optional().describe("Parent chapter id, for pages inside a chapter."),
  preview: z.string().optional().describe("Plain-text excerpt around the match."),
};

const outputShape = {
  ...paginationOutputShape,
  page: z.number().describe("Page number of this response."),
  next_page: z.number().optional().describe("Page number to request next, when has_more is true."),
  items: z.array(z.object(searchItemShape)),
};

interface SearchItem {
  id: number;
  name: string;
  type: string;
  slug?: string;
  book_id?: number;
  chapter_id?: number;
  preview?: string;
  updated_at?: string;
  created_at?: string;
  tags?: string;
  url?: string;
}

function toItem(result: BookStackSearchResult): SearchItem {
  const preview = stripHtml(result.preview_html?.content);
  return {
    ...summarize(result),
    type: result.type,
    ...(result.book_id !== undefined ? { book_id: result.book_id } : {}),
    ...(result.chapter_id !== undefined ? { chapter_id: result.chapter_id } : {}),
    ...(preview ? { preview: preview.slice(0, 300) } : {}),
  };
}

function render(query: string, payload: Paginated<SearchItem>): string {
  const header = `# Search results for '${query}'\n\nFound ${payload.total} match(es), showing ${payload.count}.\n`;
  const blocks = payload.items.map((item) =>
    lines(
      `## [${item.type}] ${item.name} (id: ${item.id})`,
      line("Book id", item.book_id),
      line("Chapter id", item.chapter_id),
      line("Updated", item.updated_at),
      line("Tags", item.tags),
      line("Preview", item.preview),
      line("URL", item.url),
    ),
  );
  return `${header}\n${blocks.join("\n\n")}${paginationFooter(payload)}`;
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "bookstack_search",
    {
      title: "Search the BookStack wiki",
      description: `Full-text search across every book, chapter and page in the BookStack wiki.

This is the fastest way to locate existing content before reading or updating it. It searches names, body text and tags. It does NOT create or modify anything.

Args:
  - query (string): search terms, optionally with BookStack search syntax (see the parameter description)
  - count (number): results per page, 1-${MAX_COUNT} (default: ${DEFAULT_COUNT})
  - page (number): 1-based page number (default: 1)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns (json format):
  {
    "total": number,        // total matches
    "count": number,        // matches in this response
    "page": number,         // current page
    "has_more": boolean,
    "next_page": number,    // present when has_more is true
    "items": [
      {
        "id": number,       // id of the matched item, scoped to its type
        "name": string,
        "type": string,     // "page" | "chapter" | "book" | "bookshelf"
        "book_id": number,  // for pages and chapters
        "chapter_id": number,
        "preview": string,  // plain-text excerpt
        "updated_at": string,
        "tags": string,
        "url": string
      }
    ]
  }

Examples:
  - Use when: "what did we write about the WireGuard setup?" -> query="wireguard"
  - Use when: "find pages tagged project=nivel" -> query="[project=nivel] {type:page}"
  - Use when: "notes touched since June" -> query="{updated_after:2026-06-01}"
  - Don't use when: you already know the page id (use bookstack_get_page)

Error handling:
  - Returns "No results found for '<query>'" when the search is empty; try fewer or broader terms.
  - A 403 means the token's role cannot see the matching content.`,
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: SearchArgs) => {
      try {
        const envelope = await apiRequest<ListEnvelope<BookStackSearchResult>>("/search", {
          query: { query: args.query, count: args.count, page: args.page },
        });

        const results = envelope?.data ?? [];
        const total = envelope?.total ?? results.length;

        if (results.length === 0) {
          const empty = {
            total: 0,
            count: 0,
            offset: 0,
            page: args.page,
            has_more: false,
            items: [],
          };
          return toolSuccess(
            `No results found for '${args.query}'. Try fewer terms, drop any {type:...} filter, ` +
              `or use bookstack_list_books to browse the wiki structure.`,
            empty,
          );
        }

        const offset = (args.page - 1) * args.count;
        const base = paginate(total, offset, results.map(toItem));
        const { text, payload } = capListing(base, (current) => render(args.query, current));

        const structured = {
          ...payload,
          page: args.page,
          ...(payload.has_more ? { next_page: args.page + 1 } : {}),
        };

        return toolSuccess(
          args.response_format === "json" ? JSON.stringify(structured, null, 2) : text,
          structured,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
