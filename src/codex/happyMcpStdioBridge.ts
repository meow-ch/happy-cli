/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing a single tool `change_title`.
 * On invocation it forwards the tool call to an existing Happy HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

function formatBridgeError(error: unknown): string {
  // StreamableHTTPError has a numeric `code` (HTTP status) but is not exported as a type from all build targets.
  // We surface it if present so the UI is actionable.
  const anyErr = error as any;
  const msg =
    error instanceof Error
      ? (error.message || String(error))
      : String(error ?? 'Unknown error');

  if (anyErr && typeof anyErr === 'object' && typeof anyErr.code === 'number') {
    return `${msg} (HTTP ${anyErr.code})`;
  }

  return msg;
}

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'happy-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
  });

  const changeTitleToolSchema = {
    description: 'Change the title of the current chat session',
    title: 'Change Chat Title',
    // MCP SDK expects a Zod schema (not a plain object of fields).
    inputSchema: z.object({
      title: z.string().describe('The new title for the chat session'),
    }),
  };

  const changeTitleToolHandler = async (args: any) => {
    try {
      const client = await ensureHttpClient();
      const response = await client.callTool({ name: 'change_title', arguments: args });
      // Pass-through response from HTTP server
      return response as any;
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to change chat title: ${formatBridgeError(error)}`,
          },
        ],
        isError: true,
      };
    }
  };

  // Register primary tool name used in our MCP prompts.
  server.registerTool('change_title', changeTitleToolSchema, changeTitleToolHandler);
  // Some MCP tool routers escape underscores as double-underscores in composite names.
  // Register an alias so calls to `mcp__happy__change__title` can still resolve.
  server.registerTool('change__title', changeTitleToolSchema, changeTitleToolHandler);
  // Register an alias for compatibility with older prompts / transports.
  server.registerTool('happy__change_title', changeTitleToolSchema, changeTitleToolHandler);
  server.registerTool('happy__change__title', changeTitleToolSchema, changeTitleToolHandler);

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});

