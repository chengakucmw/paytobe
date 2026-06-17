#!/usr/bin/env node
import { startStdioServer } from "./mcp.js";
import { callTool, tools } from "./tools.js";

startStdioServer({
  tools,
  callTool,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
});
