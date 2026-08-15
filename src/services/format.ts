/**
 * Shared output helpers: pagination envelopes, markdown rendering, truncation
 * and the two tool-result shapes. Every tool funnels its output through here so
 * responses stay consistent and context-efficient.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { formatError } from "./client.js";
import type { BookStackTag } from "../types.js";

export type ResponseFormat = "markdown" | "json";

export interface Paginated<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  items: T[];
  truncated?: boolean;
  truncation_message?: string;
}

/** Wrap a page of results with the pagination metadata agents rely on. */
export function paginate<T>(total: number, offset: number, items: T[]): Paginated<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
    items,
  };
}

/**
 * MCP result shape for a successful call.
 *
 * Declared as a type alias rather than an interface on purpose: the SDK's
 * `CallToolResult` is a passthrough Zod schema, so its type carries an index
 * signature. TypeScript grants an implicit index signature to object type
 * aliases but never to interfaces, so an interface here fails to assign at
 * every registerTool call site.
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * @param structured Payload matching the tool's declared outputSchema. Typed as
 * `object` so plain interfaces (which lack an index signature) can be passed
 * without restating them as records at every call site.
 */
export function toolSuccess(text: string, structured?: object): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured as Record<string, unknown> } : {}),
  };
}

/** MCP result shape for a failure, reported in-band so the agent can recover. */
export function toolFailure(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: formatError(error) }],
  };
}

/**
 * Enforce CHARACTER_LIMIT on a rendered listing by dropping trailing items.
 *
 * Mutates nothing: returns the text to emit and the (possibly reduced) payload.
 */
export function capListing<T>(
  payload: Paginated<T>,
  render: (payload: Paginated<T>) => string,
): { text: string; payload: Paginated<T> } {
  let text = render(payload);
  if (text.length <= CHARACTER_LIMIT) return { text, payload };

  let items = payload.items;
  let capped = payload;
  while (text.length > CHARACTER_LIMIT && items.length > 1) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    capped = {
      ...payload,
      count: items.length,
      items,
      has_more: true,
      next_offset: payload.offset + items.length,
      truncated: true,
      truncation_message:
        `Response truncated from ${payload.items.length} to ${items.length} items to stay within ` +
        `the size limit. Re-run with offset=${payload.offset + items.length} for the rest, ` +
        `or narrow the query with filters.`,
    };
    text = render(capped);
  }
  return { text, payload: capped };
}

/** Enforce CHARACTER_LIMIT on a single long body of text (e.g. page content). */
export function capText(text: string, note: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return {
    text: `${text.slice(0, CHARACTER_LIMIT)}\n\n[... truncated at ${CHARACTER_LIMIT} characters. ${note}]`,
    truncated: true,
  };
}

/** `[key=value, key2]` — compact enough to be worth including in listings. */
export function formatTags(tags: BookStackTag[] | undefined): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags.map((tag) => (tag.value ? `${tag.name}=${tag.value}` : tag.name)).join(", ");
}

/** `2026-08-15 14:03` — shorter than an ISO string and easier to read. */
export function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Best-effort plain text from a snippet of HTML (search previews only).
 *
 * Entities are decoded in a single pass so that a double-encoded sequence such
 * as `&amp;lt;` does not get resolved twice. BookStack emits PHP-style padded
 * numeric entities (`&#039;`), hence the generic numeric handling rather than a
 * lookup table of the common ones.
 */
export function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Render a `key: value` line only when the value is present. */
export function line(label: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return `- **${label}**: ${value}`;
}

/** Join optional lines, dropping the undefined ones. */
export function lines(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).join("\n");
}

/** Standard footer telling the agent how to fetch the next page. */
export function paginationFooter<T>(payload: Paginated<T>): string {
  if (payload.truncation_message) return `\n_${payload.truncation_message}_`;
  if (!payload.has_more) return "";
  return `\n_Showing ${payload.count} of ${payload.total}. Pass offset=${payload.next_offset} for the next page._`;
}
