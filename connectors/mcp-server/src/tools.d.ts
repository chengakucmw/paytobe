export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export const tools: readonly McpToolDefinition[];

export function callTool(
  name: string,
  args?: Record<string, unknown>,
  settings?: {
    baseUrl?: string;
    connectionToken?: string;
    fetch?: typeof fetch;
  }
): Promise<McpToolResult>;
