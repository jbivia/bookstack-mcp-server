#!/usr/bin/env node
/**
 * MCP server for a self-hosted BookStack wiki.
 *
 * Exposes read tools (search, browse, read pages) and authoring tools (create
 * books, chapters and pages; rename or re-describe a book; append to or rewrite
 * existing pages). Deletion is deliberately not implemented: removing wiki
 * content stays a human action.
 *
 * Transport: stdio. Nothing may be written to stdout except protocol traffic,
 * so all logging goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  ENV_BASE_URL,
  ENV_TOKEN_ID,
  ENV_TOKEN_SECRET,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import { apiRequest, formatError, loadConfig } from "./services/client.js";
import { patchTransportSchemaDialect } from "./services/compat.js";
import { registerBookTools } from "./tools/books.js";
import { registerChapterTools } from "./tools/chapters.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerPageTools } from "./tools/pages.js";
import { registerSearchTools } from "./tools/search.js";
import { registerShelfTools } from "./tools/shelves.js";
import type { BookStackBook, ListEnvelope } from "./types.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerSearchTools(server);
  registerBookTools(server);
  registerShelfTools(server);
  registerChapterTools(server);
  registerPageTools(server);
  registerNoteTools(server);
  return server;
}

const HELP = `${SERVER_NAME} v${SERVER_VERSION}

MCP server exposing a self-hosted BookStack wiki over stdio.

Usage:
  ${SERVER_NAME}            Start the MCP server on stdio (how MCP clients launch it)
  ${SERVER_NAME} --check    Verify configuration and connectivity, then exit
  ${SERVER_NAME} --help     Show this message

Environment:
  ${ENV_BASE_URL}       Wiki root URL, e.g. https://wiki.example.com (with or without /api)
  ${ENV_TOKEN_ID}       API token id     (BookStack: Edit Profile > API Tokens)
  ${ENV_TOKEN_SECRET}   API token secret

The token's role also needs the "Access system API" permission.
`;

/** Verify credentials and reachability without starting the protocol loop. */
async function runCheck(): Promise<number> {
  try {
    const config = loadConfig();
    process.stdout.write(`Endpoint: ${config.apiUrl}\n`);
    const envelope = await apiRequest<ListEnvelope<BookStackBook>>("/books", {
      query: { count: 1 },
    });
    process.stdout.write(
      `Connection OK. ${envelope?.total ?? 0} book(s) visible to this token.\n`,
    );
    return 0;
  } catch (error) {
    process.stdout.write(`${formatError(error)}\n`);
    return 1;
  }
}

async function runStdio(): Promise<void> {
  try {
    loadConfig();
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }

  const server = buildServer();
  // Rewrites the JSON Schema dialect declared on tool schemas; see services/compat.ts.
  const transport = patchTransportSchemaDialect(new StdioServerTransport());
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--check")) {
    process.exit(await runCheck());
  }
  await runStdio();
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
