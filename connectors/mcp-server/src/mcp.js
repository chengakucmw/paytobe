const JSON_RPC_VERSION = "2.0";
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export function startStdioServer({ tools, callTool, stdin, stdout, stderr = process.stderr }) {
  let buffer = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleLine(line, { tools, callTool, stdout, stderr });
    }
  });

  stdin.on("end", () => {
    const line = buffer.trim();
    if (line) handleLine(line, { tools, callTool, stdout, stderr });
  });
}

export async function handleJsonRpcMessage(message, { tools, callTool }) {
  if (!isRecord(message)) {
    return errorResponse(null, -32600, "Invalid Request");
  }

  const id = Object.hasOwn(message, "id") ? message.id : undefined;
  const isNotification = id === undefined || id === null;

  if (message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== "string") {
    return isNotification ? null : errorResponse(id, -32600, "Invalid Request");
  }

  if (message.method === "notifications/initialized") return null;

  try {
    switch (message.method) {
      case "initialize":
        return response(id, initializeResult(message.params));
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, {
          tools: tools.map((tool) => ({ ...tool }))
        });
      case "tools/call":
        return response(id, await handleToolCall(message.params, { tools, callTool }));
      default:
        return isNotification ? null : errorResponse(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (error instanceof JsonRpcError) {
      return isNotification ? null : errorResponse(id, error.code, error.message);
    }
    return isNotification ? null : errorResponse(id, -32603, error.message || "Internal error");
  }
}

async function handleLine(line, context) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(context.stdout, errorResponse(null, -32700, "Parse error"));
    return;
  }

  const reply = await handleJsonRpcMessage(message, context);
  if (reply) writeMessage(context.stdout, reply);
}

async function handleToolCall(params, { tools, callTool }) {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new JsonRpcError(-32602, "tools/call requires params.name");
  }
  const known = tools.some((tool) => tool.name === params.name);
  if (!known) throw new JsonRpcError(-32602, `Unknown tool: ${params.name}`);
  return callTool(params.name, params.arguments || {});
}

function initializeResult(params = {}) {
  const requested = isRecord(params) && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion: requested,
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    serverInfo: {
      name: "Paytobe-mcp-server",
      title: "Paytobe MCP Server",
      version: "0.1.0"
    },
    instructions: "Use these tools to create Paytobe pairing sessions, Transaction Contexts, Payment Requests, and read status. This server never signs transactions or bypasses wallet approval."
  };
}

function response(id, result) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result
  };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function writeMessage(stdout, message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class JsonRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
