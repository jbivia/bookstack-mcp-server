/**
 * Reusable Zod fragments.
 *
 * The MCP SDK's `registerTool` expects a raw shape (a plain object of Zod
 * types), not a `z.object(...)`, so everything here is exported as a field or a
 * spreadable shape rather than a built schema.
 */

import { z } from "zod";
import { DEFAULT_COUNT, MAX_COUNT } from "../constants.js";

export const responseFormatField = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe(
    "Output format: 'markdown' for a compact human-readable summary (default), " +
      "'json' for the full structured payload.",
  );

/** Standard `count` / `offset` pair for listing tools. */
export const paginationShape = {
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_COUNT)
    .default(DEFAULT_COUNT)
    .describe(`Maximum number of items to return (1-${MAX_COUNT}, default ${DEFAULT_COUNT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of items to skip, for pagination. Use the next_offset from a previous call."),
};

export const sortField = z
  .string()
  .optional()
  .describe(
    "Sort expression: a field name prefixed with '+' (ascending) or '-' (descending), " +
      "e.g. '-updated_at' for most recently changed first. Common fields: name, created_at, updated_at.",
  );

export const tagsField = z
  .array(
    z.object({
      name: z.string().min(1).describe("Tag name, e.g. 'source'."),
      value: z.string().default("").describe("Tag value, e.g. 'claude-session'. May be empty."),
    }),
  )
  .optional()
  .describe(
    "Tags to attach. Sending this field REPLACES all existing tags on the item; " +
      "omit it to leave tags untouched.",
  );

/** Output shape fragment shared by every paginated tool. */
export const paginationOutputShape = {
  total: z.number().describe("Total number of matching items in the wiki."),
  count: z.number().describe("Number of items in this response."),
  offset: z.number().describe("Offset this response starts at."),
  has_more: z.boolean().describe("Whether more items are available."),
  next_offset: z.number().optional().describe("Offset to pass to get the next page."),
  truncated: z.boolean().optional().describe("Whether items were dropped to fit the size limit."),
  truncation_message: z.string().optional().describe("Explanation when truncated is true."),
};

/** Fields common to every entity summary returned by this server. */
export const entitySummaryShape = {
  id: z.number(),
  name: z.string(),
  slug: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  tags: z.string().optional().describe("Tags rendered as 'name=value, name2'."),
  url: z.string().optional().describe("Browsable web URL, when BookStack supplies one."),
};

/** Books and shelves share this summary shape. */
export const describedSummaryShape = {
  ...entitySummaryShape,
  description: z.string().optional(),
};
