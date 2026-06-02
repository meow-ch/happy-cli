export type CodexMcpServerConfig = Record<string, unknown>;
export type CodexMcpServers = Record<string, CodexMcpServerConfig>;

export const CODEX_EXTERNAL_MCP_SERVERS_ENV = 'HAPPY_CODEX_MCP_SERVERS_JSON';
export const RESERVED_CODEX_MCP_SERVER_NAMES = new Set(['happy']);

export function parseExternalCodexMcpServers(
    raw: string | undefined,
): { servers: CodexMcpServers; warning: string | null } {
    const trimmed = raw?.trim();
    if (!trimmed) return { servers: {}, warning: null };

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (err) {
        return {
            servers: {},
            warning: `Ignoring invalid ${CODEX_EXTERNAL_MCP_SERVERS_ENV}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    if (!isPlainRecord(parsed)) {
        return {
            servers: {},
            warning: `Ignoring invalid ${CODEX_EXTERNAL_MCP_SERVERS_ENV}: expected an object`,
        };
    }

    const servers: CodexMcpServers = {};
    for (const [name, config] of Object.entries(parsed)) {
        if (RESERVED_CODEX_MCP_SERVER_NAMES.has(name)) {
            return {
                servers: {},
                warning: `Ignoring invalid ${CODEX_EXTERNAL_MCP_SERVERS_ENV}: server name "${name}" is reserved`,
            };
        }
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
            return {
                servers: {},
                warning: `Ignoring invalid ${CODEX_EXTERNAL_MCP_SERVERS_ENV}: invalid server name "${name}"`,
            };
        }
        if (!isPlainRecord(config)) {
            return {
                servers: {},
                warning: `Ignoring invalid ${CODEX_EXTERNAL_MCP_SERVERS_ENV}: server "${name}" must be an object`,
            };
        }
        servers[name] = config;
    }
    return { servers, warning: null };
}

export function mergeCodexMcpServers(
    builtIn: CodexMcpServers,
    external: CodexMcpServers,
): CodexMcpServers {
    return {
        ...external,
        ...builtIn,
    };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
