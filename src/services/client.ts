/**
 * BookStack API client.
 *
 * Centralises configuration, authentication, timeouts and error translation so
 * that no tool ever talks to `fetch` directly.
 */

import {
  ENV_BASE_URL,
  ENV_TOKEN_ID,
  ENV_TOKEN_SECRET,
  REQUEST_TIMEOUT_MS,
} from "../constants.js";
import type { BookStackErrorBody } from "../types.js";

export interface BookStackConfig {
  /** Absolute API root, e.g. `https://wiki.example.com/api`. */
  apiUrl: string;
  /** Absolute web root, e.g. `https://wiki.example.com`. Used to build links. */
  webUrl: string;
  tokenId: string;
  tokenSecret: string;
}

/** Error carrying an HTTP status plus a hint the agent can act on. */
export class BookStackError extends Error {
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, status?: number, hint?: string) {
    super(message);
    this.name = "BookStackError";
    this.status = status;
    this.hint = hint;
  }
}

let cachedConfig: BookStackConfig | undefined;

/**
 * Read and validate configuration from the environment.
 *
 * Accepts the base URL with or without a trailing `/api`, so both
 * `https://wiki.example.com` and `https://wiki.example.com/api` work.
 */
export function loadConfig(): BookStackConfig {
  if (cachedConfig) return cachedConfig;

  const rawUrl = process.env[ENV_BASE_URL]?.trim();
  const tokenId = process.env[ENV_TOKEN_ID]?.trim();
  const tokenSecret = process.env[ENV_TOKEN_SECRET]?.trim();

  const missing: string[] = [];
  if (!rawUrl) missing.push(ENV_BASE_URL);
  if (!tokenId) missing.push(ENV_TOKEN_ID);
  if (!tokenSecret) missing.push(ENV_TOKEN_SECRET);
  if (missing.length > 0 || !rawUrl || !tokenId || !tokenSecret) {
    throw new BookStackError(
      `Missing required environment variable(s): ${missing.join(", ")}.`,
      undefined,
      `Set them in the MCP client configuration. Create the token in BookStack under ` +
        `Edit Profile > API Tokens; the role also needs the "Access system API" permission.`,
    );
  }

  const withoutTrailingSlash = rawUrl.replace(/\/+$/, "");
  const webUrl = withoutTrailingSlash.replace(/\/api$/, "");
  const apiUrl = `${webUrl}/api`;

  try {
    // Throws on a malformed URL, e.g. a missing scheme.
    void new URL(apiUrl);
  } catch {
    throw new BookStackError(
      `${ENV_BASE_URL} is not a valid URL: "${rawUrl}".`,
      undefined,
      `Use an absolute URL including the scheme, e.g. https://wiki.example.com`,
    );
  }

  cachedConfig = { apiUrl, webUrl, tokenId, tokenSecret };
  return cachedConfig;
}

/** Build a browsable web URL for an entity, or `undefined` if not derivable. */
export function webLink(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  const { webUrl } = loadConfig();
  return `${webUrl}/${path.replace(/^\/+/, "")}`;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/**
 * Authenticate, send and check one request. Shared by every public helper so
 * that auth, timeouts and error translation are defined exactly once.
 *
 * @param accept Value of the `Accept` header. Endpoints outside the JSON API
 * need a different one; see apiRequestText.
 * @throws BookStackError with an actionable hint on any non-2xx response.
 */
async function performRequest(
  path: string,
  options: RequestOptions,
  accept: string,
): Promise<Response> {
  const config = loadConfig();
  const { method = "GET", query, body } = options;

  const url = new URL(`${config.apiUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Token ${config.tokenId}:${config.tokenSecret}`,
    Accept: accept,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw translateNetworkError(error, url);
  }

  if (!response.ok) {
    throw await translateHttpError(response);
  }
  return response;
}

/**
 * Perform an authenticated request against the BookStack JSON API.
 *
 * @param path API path starting with a slash, e.g. `/pages/12`.
 * @throws BookStackError with an actionable hint on any non-2xx response.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await performRequest(path, options, "application/json");

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (text.length === 0) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BookStackError(
      `BookStack returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
      `This usually means ${ENV_BASE_URL} points at something other than a BookStack instance, ` +
        `or a reverse proxy returned an error page.`,
    );
  }
}

/**
 * Same, for the endpoints that do not answer in JSON.
 *
 * The export routes (`/books/{id}/export/markdown`) return the file itself as
 * `application/octet-stream`, so apiRequest would reject a perfectly good
 * response for failing to parse as JSON.
 */
export async function apiRequestText(path: string): Promise<string> {
  const response = await performRequest(path, {}, "*/*");
  return response.text();
}

function translateNetworkError(error: unknown, url: URL): BookStackError {
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = (cause as NodeJS.ErrnoException).code ?? "";
  const nested = (cause as { cause?: NodeJS.ErrnoException }).cause?.code ?? "";
  const combined = `${cause.name} ${code} ${nested}`.toUpperCase();

  if (cause.name === "TimeoutError" || combined.includes("ABORT")) {
    return new BookStackError(
      `Request to ${url.host} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
      undefined,
      `Check that the wiki host is reachable from this machine (VPN or LAN).`,
    );
  }
  if (combined.includes("ENOTFOUND") || combined.includes("EAI_AGAIN")) {
    return new BookStackError(
      `Cannot resolve host "${url.host}".`,
      undefined,
      `This host only resolves on the local network. Connect to the LAN or VPN, or use the LAN IP.`,
    );
  }
  if (combined.includes("ECONNREFUSED") || combined.includes("EHOSTUNREACH")) {
    return new BookStackError(
      `Connection to ${url.host} refused or unreachable.`,
      undefined,
      `Check that the BookStack container is running and the port is exposed.`,
    );
  }
  if (combined.includes("CERT") || combined.includes("SELF_SIGNED")) {
    return new BookStackError(
      `TLS certificate for ${url.host} was rejected.`,
      undefined,
      `Trust the CA by pointing NODE_EXTRA_CA_CERTS at your root certificate file.`,
    );
  }
  return new BookStackError(
    `Network error contacting ${url.host}: ${cause.message}`,
    undefined,
    `Verify ${ENV_BASE_URL} and that the wiki is reachable from this machine.`,
  );
}

async function translateHttpError(response: Response): Promise<BookStackError> {
  let detail = "";
  let validation: string | undefined;

  try {
    const parsed = (await response.json()) as BookStackErrorBody;
    detail = parsed.error?.message ?? parsed.message ?? "";
    const fields = parsed.error?.validation;
    if (fields) {
      validation = Object.entries(fields)
        .map(([field, messages]) => `${field}: ${messages.join(" ")}`)
        .join(" | ");
    }
  } catch {
    // Non-JSON error body (proxy error page); the status alone will have to do.
  }

  const suffix = detail ? ` ${detail}` : "";

  switch (response.status) {
    case 401:
      return new BookStackError(
        `Authentication failed (401).${suffix}`,
        401,
        `Check ${ENV_TOKEN_ID} and ${ENV_TOKEN_SECRET}, and that the token has not expired.`,
      );
    case 403:
      return new BookStackError(
        `Permission denied (403).${suffix}`,
        403,
        `The token's role needs "Access system API" plus permission on this content. ` +
          `Content in a restricted book will 403 even with a valid token.`,
      );
    case 404:
      return new BookStackError(
        `Not found (404).${suffix}`,
        404,
        `Verify the id. Use bookstack_search or a listing tool to find the correct one. ` +
          `Note that ids are not shared across types: page 12 and book 12 are different items.`,
      );
    case 422:
      return new BookStackError(
        `Validation failed (422).${validation ? ` ${validation}` : suffix}`,
        422,
        `Fix the offending field and retry. Creating a page requires a name and either ` +
          `book_id or chapter_id, plus markdown or html content.`,
      );
    case 429:
      return new BookStackError(
        `Rate limit exceeded (429).${suffix}`,
        429,
        `BookStack allows 180 API requests per minute by default. Wait, then retry with a smaller count.`,
      );
    default:
      return new BookStackError(
        `BookStack API request failed with HTTP ${response.status}.${suffix}`,
        response.status,
        response.status >= 500
          ? `The wiki returned a server error. Check the BookStack container logs.`
          : undefined,
      );
  }
}

/** Render any thrown value as a single actionable line for the agent. */
export function formatError(error: unknown): string {
  if (error instanceof BookStackError) {
    return error.hint ? `Error: ${error.message} ${error.hint}` : `Error: ${error.message}`;
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}
