#!/usr/bin/env node
/**
 * Entry point: a stdio MCP server that exposes control of a Windows PowerShell
 * session reached through a Citrix/RDP window, using the synced clipboard as the
 * transport. stdout is owned by the MCP transport — all logging goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MacClipboard } from "./clipboard.js";
import { config } from "./config.js";
import { Relay } from "./relay.js";
import { registerTools } from "./tools.js";
import { log } from "./util.js";

async function main(): Promise<void> {
  const clipboard = new MacClipboard();
  const relay = new Relay(clipboard, config);

  const server = new McpServer({
    name: "remote-desktop-terminal",
    version: "0.1.0",
  });

  registerTools(server, relay);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", `MCP server ready (session ${relay.sessionId})`);
  log(
    "info",
    `clipboard transport · poll ${config.pollIntervalMs}ms · chunk ${config.chunkBytes}B`,
  );

  const shutdown = (signal: string) => {
    log("info", `received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log("error", `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
