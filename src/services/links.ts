/**
 * Page URL resolution.
 *
 * BookStack page URLs are `/books/{book-slug}/page/{page-slug}`, but the API
 * returns only `book_id` on a page. Resolving the book slug therefore costs one
 * extra request, which this module caches per book.
 *
 * Two deliberate choices:
 *
 * - Entries expire after a short TTL. A renamed book gets a new slug, and a
 *   cached link would then point at nothing; a stale URL is worse than a
 *   slightly slower one.
 * - Every failure is swallowed. A URL is a convenience, so a lookup that 404s
 *   or times out must never turn a successful page write into a tool error.
 */

import { apiRequest, webLink } from "./client.js";
import type { BookStackBook } from "../types.js";

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  slug: string;
  expiresAt: number;
}

const bookSlugs = new Map<number, CacheEntry>();

/**
 * Seed the cache from a payload that already carries the slug.
 *
 * Listing and read tools get the slug for free, so calling this from them means
 * most page URLs resolve without any extra request.
 */
export function rememberBookSlug(bookId: number, slug: string | undefined): void {
  if (!slug) return;
  bookSlugs.set(bookId, { slug, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Resolve a book's slug, from cache when possible. Returns undefined on failure. */
export async function resolveBookSlug(bookId: number): Promise<string | undefined> {
  const cached = bookSlugs.get(bookId);
  if (cached && cached.expiresAt > Date.now()) return cached.slug;
  if (cached) bookSlugs.delete(bookId);

  try {
    const book = await apiRequest<BookStackBook>(`/books/${bookId}`);
    rememberBookSlug(bookId, book.slug);
    return book.slug;
  } catch {
    return undefined;
  }
}

/** Build the browsable URL of a page, or undefined when it cannot be resolved. */
export async function buildPageUrl(
  bookId: number,
  pageSlug: string | undefined,
): Promise<string | undefined> {
  if (!pageSlug) return undefined;
  const slug = await resolveBookSlug(bookId);
  if (!slug) return undefined;
  return webLink(`books/${slug}/page/${pageSlug}`);
}

/**
 * Add a `url` to a page summary when one is not already present.
 *
 * Applied to single-page operations only. Listings skip it on purpose: pages
 * spanning many books would each trigger a lookup, turning a cheap listing into
 * a burst of requests.
 */
export async function attachPageUrl<T extends { book_id: number; slug?: string; url?: string }>(
  summary: T,
): Promise<T> {
  if (summary.url) return summary;
  const url = await buildPageUrl(summary.book_id, summary.slug);
  return url ? { ...summary, url } : summary;
}
