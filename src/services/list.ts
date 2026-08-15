/**
 * Generic helper for BookStack listing endpoints.
 *
 * All of them share the same contract: `count` / `offset` / `sort` query params,
 * `filter[field]` style filters, and a `{ data, total }` envelope.
 */

import { apiRequest, type QueryValue } from "./client.js";
import type { ListEnvelope } from "../types.js";

export interface ListParams {
  count: number;
  offset: number;
  sort?: string;
  /** Filters expressed without the `filter[]` wrapper, e.g. `{ book_id: 3 }`. */
  filters?: Record<string, QueryValue>;
}

export async function fetchList<T>(
  resource: string,
  params: ListParams,
): Promise<ListEnvelope<T>> {
  const query: Record<string, QueryValue> = {
    count: params.count,
    offset: params.offset,
  };
  if (params.sort) query["sort"] = params.sort;
  for (const [field, value] of Object.entries(params.filters ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      query[`filter[${field}]`] = value;
    }
  }

  const envelope = await apiRequest<ListEnvelope<T>>(`/${resource}`, { query });
  return { data: envelope?.data ?? [], total: envelope?.total ?? 0 };
}
