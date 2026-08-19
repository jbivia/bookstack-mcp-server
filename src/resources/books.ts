/**
 * Books exposed as MCP resources, reachable by URI without a tool call.
 *
 * Two URIs per book, only the first of which is listed:
 *
 *   bookstack://book/{book_id}          metadata + chapter/page outline
 *   bookstack://book/{book_id}/content  the whole book as markdown
 *
 * The split is deliberate. The outline is cheap and bounded, so it is safe to
 * enumerate and safe for an agent to read on a hunch. The full export is not:
 * a single book here already runs to ~48 000 characters, so its description
 * tells the agent to read it only when asked. Keeping it out of the listing is
 * the other half of that guard rail — an unlisted template is still readable,
 * just not something a client offers up by default.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { MAX_COUNT, RESOURCE_CHARACTER_LIMIT } from "../constants.js";
import { BookStackError, apiRequest, apiRequestText, formatError } from "../services/client.js";
import { renderContents, renderSummary, summarizeDescribed } from "../services/entities.js";
import { capText, line, lines } from "../services/format.js";
import { rememberBookSlug } from "../services/links.js";
import { fetchList } from "../services/list.js";
import type { BookStackBook } from "../types.js";

const MIME_TYPE = "text/markdown";

const OUTLINE_URI = "bookstack://book/{book_id}";
const CONTENT_URI = "bookstack://book/{book_id}/content";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A resource read that failed, carrying the JSON-RPC code to report it under.
 *
 * Deliberately not the SDK's `McpError`: that class bakes `MCP error <code>: `
 * into its own message, the server then puts that message on the wire, and the
 * client prefixes it a second time — so the user reads the code twice before
 * reaching the sentence that matters. The protocol layer only looks for a
 * numeric `code` and a `message`, which is exactly what this carries.
 */
class ResourceReadError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ResourceReadError";
    this.code = code;
  }
}

/**
 * Translate a thrown value into the error shape a resource read must produce.
 *
 * Resources have no in-band failure form: unlike a tool, which reports trouble
 * through `isError` and lets the agent recover, a read either returns contents
 * or throws. Wrapping rather than rethrowing keeps the actionable messages
 * client.ts builds — "the ids are not shared across types", "the token's role
 * needs Access system API" — instead of surfacing a bare stack trace.
 */
function asReadError(error: unknown): ResourceReadError {
  const code =
    error instanceof BookStackError && error.status === 404
      ? ErrorCode.InvalidParams
      : ErrorCode.InternalError;
  return new ResourceReadError(code, formatError(error));
}

/** Parse the `{book_id}` captured from a URI, which arrives as a string. */
function parseBookId(value: string | string[] | undefined, uri: URL): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const bookId = Number(raw);
  if (!Number.isInteger(bookId) || bookId <= 0) {
    throw new ResourceReadError(
      ErrorCode.InvalidParams,
      `Error: "${uri.href}" does not carry a valid book id. ` +
        `Expected a positive integer, as returned by bookstack_list_books.`,
    );
  }
  return bookId;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerBookResources(server: McpServer): void {
  server.registerResource(
    "book",
    new ResourceTemplate(OUTLINE_URI, {
      /**
       * Enumerate every book as an attachable resource.
       *
       * Capped at MAX_COUNT and left unpaginated on purpose: the SDK calls this
       * callback with no cursor and drops any `nextCursor` it returns, so the
       * listing is all-or-nothing. Newest first, so the cap bites on the books
       * least likely to be wanted.
       *
       * Seeding the slug cache here is free — the listing already carries every
       * slug — and spares links.ts a lookup when a later page read needs a URL.
       */
      list: async () => {
        try {
          const envelope = await fetchList<BookStackBook>("books", {
            count: MAX_COUNT,
            offset: 0,
            sort: "-updated_at",
          });

          return {
            resources: envelope.data.map((book) => {
              rememberBookSlug(book.id, book.slug);
              const description = book.description?.trim();
              return {
                uri: `bookstack://book/${book.id}`,
                name: book.name,
                title: book.name,
                mimeType: MIME_TYPE,
                description:
                  `Outline of the "${book.name}" book: chapters, pages and their ids.` +
                  (description ? ` ${description}` : ""),
              };
            }),
          };
        } catch (error) {
          throw asReadError(error);
        }
      },
    }),
    {
      title: "BookStack book outline",
      description:
        "Metadata and full chapter/page tree of one book, as markdown. Same content as " +
        "bookstack_get_book, reachable by URI. Cheap and always complete: read this first " +
        "to find the page ids you need, and only reach for bookstack://book/{book_id}/content " +
        "when the whole text is genuinely required.",
      mimeType: MIME_TYPE,
    },
    async (uri, variables) => {
      const bookId = parseBookId(variables["book_id"], uri);
      try {
        const book = await apiRequest<BookStackBook>(`/books/${bookId}`);
        rememberBookSlug(book.id, book.slug);
        const summary = summarizeDescribed(book, "books");

        const text = lines(
          renderSummary(summary, "#", [line("Description", summary.description)]),
          "",
          "## Contents",
          renderContents(book.contents),
          "",
          `_Full text of this book: ${uri.href}/content_`,
        );

        return { contents: [{ uri: uri.href, mimeType: MIME_TYPE, text }] };
      } catch (error) {
        throw asReadError(error);
      }
    },
  );

  server.registerResource(
    "book-content",
    // `list: undefined` keeps this template out of resources/list. It stays
    // discoverable through resources/templates/list, which is the point: the
    // expensive read should be something you go and ask for, not something a
    // client puts in front of you next to the cheap ones.
    new ResourceTemplate(CONTENT_URI, { list: undefined }),
    {
      title: "BookStack book, full text",
      description:
        "Every page of one book concatenated as markdown, via BookStack's export endpoint. " +
        "This is a large payload — a mid-sized book runs to tens of thousands of characters. " +
        "Do not read it on your own initiative: use it only when the user asks for the whole " +
        "book, and prefer bookstack://book/{book_id} plus bookstack_get_page on the pages that " +
        "matter otherwise.",
      mimeType: MIME_TYPE,
    },
    async (uri, variables) => {
      const bookId = parseBookId(variables["book_id"], uri);
      try {
        const exported = await apiRequestText(`/books/${bookId}/export/markdown`);
        const { text } = capText(
          exported,
          `Read the remaining pages individually with bookstack_get_page, ` +
            `using the ids from bookstack://book/${bookId}.`,
          RESOURCE_CHARACTER_LIMIT,
        );

        return { contents: [{ uri: uri.href, mimeType: MIME_TYPE, text }] };
      } catch (error) {
        throw asReadError(error);
      }
    },
  );
}
