/**
 * TypeScript interfaces mirroring the BookStack REST API payloads.
 *
 * Only the fields this server actually reads are declared. Every field that the
 * API may omit depending on endpoint (list vs. detail) or version is optional,
 * so a schema drift on the BookStack side degrades gracefully instead of
 * throwing.
 */

export interface BookStackTag {
  name: string;
  value: string;
  order?: number;
}

/** Envelope returned by every `GET /api/{resource}` listing endpoint. */
export interface ListEnvelope<T> {
  data: T[];
  total: number;
}

interface BaseEntity {
  id: number;
  name: string;
  slug?: string;
  created_at?: string;
  updated_at?: string;
  created_by?: number | { id: number; name: string };
  updated_by?: number | { id: number; name: string };
  tags?: BookStackTag[];
  url?: string;
}

export interface BookStackShelf extends BaseEntity {
  description?: string;
  /** Present on `GET /api/shelves/{id}`: the books assigned to this shelf. */
  books?: { id: number; name: string; slug?: string }[];
}

export interface BookStackBook extends BaseEntity {
  description?: string;
  /** Present on `GET /api/books/{id}`: the ordered chapter/page tree. */
  contents?: BookStackBookContentItem[];
}

export interface BookStackBookContentItem {
  id: number;
  name: string;
  slug?: string;
  type: "chapter" | "page";
  url?: string;
  draft?: boolean;
  pages?: BookStackBookContentItem[];
}

export interface BookStackChapter extends BaseEntity {
  book_id: number;
  description?: string;
  priority?: number;
  pages?: BookStackPage[];
}

export interface BookStackPage extends BaseEntity {
  book_id: number;
  chapter_id?: number;
  draft?: boolean;
  template?: boolean;
  priority?: number;
  /** Only present on `GET /api/pages/{id}`. */
  html?: string;
  /** Only present on `GET /api/pages/{id}`, and empty for HTML-authored pages. */
  markdown?: string;
}

export interface BookStackSearchResult extends BaseEntity {
  type: "bookshelf" | "book" | "chapter" | "page";
  book_id?: number;
  chapter_id?: number;
  preview_html?: { name?: string; content?: string };
}

/** Shape of the JSON body BookStack returns on an error. */
export interface BookStackErrorBody {
  error?: {
    code?: number;
    message?: string;
    validation?: Record<string, string[]>;
  };
  message?: string;
}
