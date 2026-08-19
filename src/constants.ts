/** Shared constants for the BookStack MCP server. */

export const SERVER_NAME = "bookstack-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum characters returned by a single tool call before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Same ceiling for a resource read. Set higher than CHARACTER_LIMIT on purpose:
 * a resource lands in the context because someone attached it or asked for it,
 * whereas a tool result lands there as a side effect of the agent's own
 * reasoning. The reader has already accepted the cost, so truncating a book
 * mid-sentence serves nobody.
 */
export const RESOURCE_CHARACTER_LIMIT = 100_000;

/** HTTP timeout for every call to the BookStack API. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Default and maximum page size for listing tools. */
export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 100;

/** Env var names, kept in one place so error messages stay consistent. */
export const ENV_BASE_URL = "BOOKSTACK_BASE_URL";
export const ENV_TOKEN_ID = "BOOKSTACK_TOKEN_ID";
export const ENV_TOKEN_SECRET = "BOOKSTACK_TOKEN_SECRET";
