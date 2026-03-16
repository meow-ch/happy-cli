/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * IMPORTANT: Creates a fresh McpServer + StreamableHTTPServerTransport per
 * request (stateless mode).  Sharing a single transport across requests causes
 * the MCP handshake / tool-listing to fail after the first connection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";

/**
 * Register all Happy-specific MCP tools on the given server instance.
 * Called once per request so every connection gets a clean tool set.
 */
function registerTools(mcp: McpServer, handler: (title: string) => Promise<{ success: boolean; error?: string }>) {
    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: z.object({
            title: z.string().describe('The new title for the chat session'),
        }),
    // @ts-ignore MCP SDK Zod deep instantiation — runtime behavior is correct
    }, async (args: { title: string }) => {
        const response = await handler(args.title);
        logger.debug('[happyMCP] Response:', response);

        return response.success
            ? { content: [{ type: 'text' as const, text: `Successfully changed chat title to: "${args.title}"` }], isError: false }
            : { content: [{ type: 'text' as const, text: `Failed to change chat title: ${response.error || 'Unknown error'}` }], isError: true };
    });
}

export async function startHappyServer(client: ApiSessionClient) {
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[happyMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the HTTP server — fresh McpServer + transport per request
    //

    const server = createServer(async (req, res) => {
        if (req.method === 'POST') {
            try {
                const mcp = new McpServer({
                    name: "Happy MCP",
                    version: "1.0.0",
                });
                registerTools(mcp, handler);

                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                });
                await mcp.connect(transport);

                res.on('close', () => {
                    transport.close().catch(() => {});
                    mcp.close().catch(() => {});
                });

                await transport.handleRequest(req, res);
            } catch (error) {
                logger.debug("[happyMCP] Error handling request:", error);
                if (!res.headersSent) {
                    const msg = error instanceof Error ? (error.stack || error.message) : String(error);
                    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end(msg);
                }
            }
        } else if (req.method === 'DELETE') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessions not supported in stateless mode' }));
        } else {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] Server listening at ${baseUrl}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title'],
        stop: () => {
            logger.debug('[happyMCP] Stopping server');
            server.close();
        }
    }
}
