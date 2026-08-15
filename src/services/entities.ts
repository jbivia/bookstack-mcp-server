/**
 * Mapping from raw BookStack entities to the trimmed summaries this server
 * returns. Keeping it in one place guarantees that a book, a chapter and a page
 * are described with the same field names.
 */

import { formatDate, formatTags, line, lines, paginationFooter } from "./format.js";
import type { Paginated } from "./format.js";
import { webLink } from "./client.js";
import type { BookStackTag } from "../types.js";

export interface EntitySummary {
  id: number;
  name: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
  tags?: string;
  url?: string;
}

interface RawEntity {
  id: number;
  name: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
  tags?: BookStackTag[];
  url?: string;
}

/**
 * @param fallbackPath URL segment used to rebuild a link from the slug when the
 * API response carries no `url` field, e.g. "books" or "shelves". BookStack
 * omits `url` on create and update responses even though it returns it on reads.
 */
export function summarize(entity: RawEntity, fallbackPath?: string): EntitySummary {
  const tags = formatTags(entity.tags);
  const url =
    webLink(entity.url) ??
    (entity.slug && fallbackPath ? webLink(`${fallbackPath}/${entity.slug}`) : undefined);
  return {
    id: entity.id,
    name: entity.name,
    ...(entity.slug ? { slug: entity.slug } : {}),
    ...(entity.created_at ? { created_at: formatDate(entity.created_at) ?? entity.created_at } : {}),
    ...(entity.updated_at ? { updated_at: formatDate(entity.updated_at) ?? entity.updated_at } : {}),
    ...(tags ? { tags } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * Render a summary as a markdown block.
 *
 * @param heading Heading level marker, e.g. `##`.
 * @param extra Additional `- **Label**: value` lines to append.
 */
export function renderSummary(
  summary: EntitySummary,
  heading: string,
  extra: (string | undefined)[] = [],
): string {
  return lines(
    `${heading} ${summary.name} (id: ${summary.id})`,
    ...extra,
    line("Updated", summary.updated_at),
    line("Tags", summary.tags),
    line("URL", summary.url),
  );
}

/* -------------------------------------------------------------------------- */
/* Describable entities (books and shelves share this shape)                   */
/* -------------------------------------------------------------------------- */

export interface DescribedSummary extends EntitySummary {
  description?: string;
}

/** Summarize an entity that carries a free-text description. */
export function summarizeDescribed(
  entity: RawEntity & { description?: string },
  fallbackPath?: string,
): DescribedSummary {
  const description = entity.description?.trim();
  return {
    ...summarize(entity, fallbackPath),
    ...(description ? { description: description.slice(0, 300) } : {}),
  };
}

/** Render a paginated list of described entities as markdown. */
export function renderDescribedCollection(
  title: string,
  payload: Paginated<DescribedSummary>,
  extra: (item: DescribedSummary) => (string | undefined)[] = () => [],
): string {
  const header = `# ${title}\n\n${payload.total} total, showing ${payload.count}.\n`;
  const blocks = payload.items.map((item) =>
    renderSummary(item, "##", [line("Description", item.description), ...extra(item)]),
  );
  return `${header}\n${blocks.join("\n\n")}${paginationFooter(payload)}`;
}
