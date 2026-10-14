/**
 * MCP over stdio: how Claude Desktop, Claude Code and Cursor connect.
 *
 * Launched as a subprocess by the client, so it must never write anything to
 * stdout that is not protocol traffic. Logs go to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { tools, callTool } from "./tools.ts";
import { close } from "../lib/db.ts";

const caller = process.env.JARVIS_CALLER ?? "mcp-stdio";

const server = new Server(
  { name: "jarvis", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments, caller),
);

const shutdown = async () => {
  await close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error("[jarvis] mcp stdio server ready");
