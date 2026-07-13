import { query } from '@/claude/sdk/query';
import type { SDKSystemMessage } from '@/claude/sdk/types';
import { logger } from '@/ui/logger';
import { execFile } from 'node:child_process';

export interface ClaudeEffortOption {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface ClaudeModelInfo {
    model: string;
    displayName?: string;
    description?: string;
    isDefault?: boolean;
    source?: 'builtin' | 'gateway' | 'custom' | 'cli';
    efforts?: ClaudeEffortOption[];
}

type ClaudeModelListOptions = {
    timeoutMs?: number;
    env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 6_000;

// Aliases the picker exposes. Mirrors `claude /model`'s 3-row shape — Opus is
// intentionally absent because Default already resolves to the latest Opus
// model (`claude /model` shows it as a single "Default (recommended) ✓" row,
// not a separate Opus entry).
const PROBE_ALIASES: ReadonlyArray<{ alias: string; description: string }> = [
    { alias: 'default', description: 'Most capable for complex work' },
    { alias: 'sonnet', description: 'Best for everyday tasks' },
    { alias: 'haiku', description: 'Fastest for quick answers' },
];

function parseClaudeEffortsFromHelp(helpText: string): ClaudeEffortOption[] {
    const lines = helpText.split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes('--effort <'));
    if (start < 0) return [];

    const block: string[] = [];
    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index];
        if (index > start && /^\s{0,4}--[a-z]/i.test(line)) break;
        block.push(line);
        if (line.includes(')')) break;
    }

    const choices = block.join(' ').match(/\(([^)]+)\)/)?.[1];
    if (!choices) return [];
    const ids = [...new Set(choices
        .split(',')
        .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
        .filter((value) => /^[a-z0-9][a-z0-9._-]*$/i.test(value)))];
    return ids.map((id) => ({
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
    }));
}

async function discoverClaudeEfforts(
    env: Record<string, string | undefined>,
    timeoutMs: number,
): Promise<ClaudeEffortOption[]> {
    return await new Promise((resolve) => {
        execFile('claude', ['--help'], {
            env,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
        }, (error, stdout) => {
            if (error) {
                logger.debug('[claudeModelList] effort discovery failed:', error);
                resolve([]);
                return;
            }
            resolve(parseClaudeEffortsFromHelp(String(stdout)));
        });
    });
}

function attachClaudeEfforts(models: ClaudeModelInfo[], efforts: ClaudeEffortOption[]): ClaudeModelInfo[] {
    return models.map((model) => ({
        ...model,
        efforts: efforts.map((effort) => ({ ...effort })),
    }));
}

export const __testClaudeModelListInternals = {
    parseClaudeEffortsFromHelp,
};

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
    const value = env[key]?.trim();
    return value ? value : undefined;
}

/**
 * Render a Claude model ID into the human label `claude /model` shows.
 *
 * Examples:
 *   claude-opus-4-7[1m]   -> "Opus 4.7 with 1M context"
 *   claude-sonnet-4-6     -> "Sonnet 4.6"
 *   claude-haiku-4-5      -> "Haiku 4.5"
 *
 * Falls back to the raw id when the pattern doesn't match (e.g. third-party
 * gateway models, future model families).
 */
function formatClaudeDisplayName(modelId: string): string {
    const m = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:\[(\d+)([kmg])\])?/i);
    if (!m) return modelId;
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const version = `${m[2]}.${m[3]}`;
    const ctx = m[4] && m[5] ? ` with ${m[4]}${m[5].toUpperCase()} context` : '';
    return `${family} ${version}${ctx}`;
}

/**
 * Spawn a Claude SDK query just long enough to capture the system/init
 * message — that message contains the resolved model ID for whichever alias
 * we passed via --model. Aborts immediately after init, so no API tokens are
 * spent. Returns null on any failure (timeout, missing claude binary, login
 * issue) so callers can fall back gracefully.
 */
async function probeAliasModel(alias: string, timeoutMs: number): Promise<string | null> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
        const sdkQuery = query({
            prompt: 'noop',
            options: {
                model: alias,
                allowedTools: [],
                maxTurns: 1,
                abort: abortController.signal,
            },
        });
        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const sys = message as SDKSystemMessage;
                abortController.abort();
                return typeof sys.model === 'string' ? sys.model : null;
            }
        }
        return null;
    } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')) {
            return null;
        }
        logger.debug(`[claudeModelList] probe failed for alias ${alias}:`, error);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build the picker rows from SDK probes — the same shape `claude /model`
 * shows. Returns null if probing didn't yield anything usable so callers can
 * try the gateway path or fall back to a static list.
 */
async function buildFromCliProbes(timeoutMs: number): Promise<ClaudeModelInfo[] | null> {
    const probes = await Promise.all(
        PROBE_ALIASES.map(async ({ alias, description }) => {
            const resolved = await probeAliasModel(alias, timeoutMs);
            return { alias, description, resolved };
        })
    );

    const successful = probes.filter((p) => !!p.resolved);
    if (successful.length === 0) return null;

    const results: ClaudeModelInfo[] = successful.map(({ alias, description, resolved }, index) => {
        const versionLabel = formatClaudeDisplayName(resolved!);
        return {
            model: alias,
            displayName: alias === 'default'
                ? 'Default (recommended)'
                : alias.charAt(0).toUpperCase() + alias.slice(1),
            description: `${versionLabel} · ${description}`,
            isDefault: alias === 'default' || (index === 0 && !successful.some((p) => p.alias === 'default')),
            source: 'cli',
        };
    });

    return results;
}

/**
 * Last-resort static rows when neither SDK probes nor a configured gateway
 * yields a list. Matches `/model`'s shape (3 rows, Default+Sonnet+Haiku) but
 * with generic descriptions — the picker will look right but won't show the
 * current model version.
 */
function buildStaticFallback(): ClaudeModelInfo[] {
    return PROBE_ALIASES.map(({ alias, description }) => ({
        model: alias,
        displayName: alias === 'default'
            ? 'Default (recommended)'
            : alias.charAt(0).toUpperCase() + alias.slice(1),
        description,
        isDefault: alias === 'default',
        source: 'builtin',
    }));
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

function parseCustomHeaders(value: string | undefined): Record<string, string> {
    if (!value?.trim()) return {};

    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const headers: Record<string, string> = {};
            for (const [key, headerValue] of Object.entries(parsed)) {
                if (typeof headerValue === 'string') headers[key] = headerValue;
            }
            return headers;
        }
    } catch {
        // Fall back to a simple comma/newline separated parser below.
    }

    const headers: Record<string, string> = {};
    for (const part of value.split(/[,\n]/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const separator = trimmed.includes(':') ? ':' : '=';
        const index = trimmed.indexOf(separator);
        if (index <= 0) continue;
        const key = trimmed.slice(0, index).trim();
        const headerValue = trimmed.slice(index + 1).trim();
        if (key && headerValue) headers[key] = headerValue;
    }
    return headers;
}

function buildHeaders(env: Record<string, string | undefined>): Record<string, string> {
    const headers: Record<string, string> = {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        ...parseCustomHeaders(envValue(env, 'ANTHROPIC_CUSTOM_HEADERS')),
    };

    const authToken = envValue(env, 'ANTHROPIC_AUTH_TOKEN');
    const apiKey = envValue(env, 'ANTHROPIC_API_KEY');

    if (authToken) {
        headers.authorization = authToken.toLowerCase().startsWith('bearer ')
            ? authToken
            : `Bearer ${authToken}`;
    } else if (apiKey) {
        headers['x-api-key'] = apiKey;
    }

    return headers;
}

function normalizeModelInfo(raw: unknown): ClaudeModelInfo | null {
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string'
        ? record.id
        : typeof record.model === 'string'
            ? record.model
            : null;
    if (!id) return null;

    const displayName = typeof record.display_name === 'string'
        ? record.display_name
        : typeof record.displayName === 'string'
            ? record.displayName
            : undefined;

    return {
        model: id,
        displayName,
        source: 'gateway',
    };
}

function isClaudeModelId(id: string): boolean {
    return /^(claude|anthropic\.|deepseek-|glm-)/i.test(id);
}

async function fetchGatewayModels(
    baseUrl: string,
    env: Record<string, string | undefined>,
    timeoutMs: number,
): Promise<ClaudeModelInfo[]> {
    const headers = buildHeaders(env);
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const models: ClaudeModelInfo[] = [];
    let afterId: string | undefined;
    const seen = new Set<string>();

    while (true) {
        const url = new URL(`${normalizedBase}/v1/models`);
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
            response = await fetch(url, { headers, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            throw new Error(`Anthropic /v1/models returned ${response.status}`);
        }

        const body = await response.json();
        const data = (body as { data?: unknown }).data;
        if (Array.isArray(data)) {
            for (const raw of data) {
                const model = normalizeModelInfo(raw);
                if (!model || seen.has(model.model)) continue;
                if (!isClaudeModelId(model.model)) continue;
                seen.add(model.model);
                models.push(model);
            }
        }

        const bodyRecord = body as { has_more?: unknown; last_id?: unknown };
        if (bodyRecord.has_more === true && typeof bodyRecord.last_id === 'string' && bodyRecord.last_id) {
            afterId = bodyRecord.last_id;
            continue;
        }
        break;
    }

    return models;
}

/**
 * List Claude models for the picker.
 *
 * Source priority:
 *   1. SDK probes — spawn `claude --model <alias>` with allowedTools=[] and
 *      capture system/init for each alias (default, sonnet, haiku). This
 *      mirrors `claude /model`'s shape (3 rows, version-aware descriptions,
 *      effort selector). Costs nothing — abort fires before any API call.
 *   2. Gateway `/v1/models` — only when `ANTHROPIC_BASE_URL` is set OR a
 *      literal `ANTHROPIC_API_KEY` is provided. For Bedrock/Vertex/proxies
 *      where the SDK's own list isn't authoritative.
 *   3. Static fallback — 3-row shape with generic descriptions, used only
 *      when both 1 and 2 fail.
 */
export async function claudeModelList(opts?: ClaudeModelListOptions): Promise<ClaudeModelInfo[]> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env: Record<string, string | undefined> = { ...process.env, ...opts?.env };
    const effortsPromise = discoverClaudeEfforts(env, Math.min(timeoutMs, PROBE_TIMEOUT_MS));

    const probed = await buildFromCliProbes(Math.min(timeoutMs, PROBE_TIMEOUT_MS));
    if (probed && probed.length > 0) {
        return attachClaudeEfforts(probed, await effortsPromise);
    }

    const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL');
    const explicitApiKey = !!envValue(env, 'ANTHROPIC_API_KEY');
    const discoveryBaseUrl = baseUrl || (explicitApiKey ? 'https://api.anthropic.com' : undefined);

    if (discoveryBaseUrl) {
        try {
            const gatewayModels = await fetchGatewayModels(discoveryBaseUrl, env, timeoutMs);
            if (gatewayModels.length > 0) {
                return attachClaudeEfforts(
                    gatewayModels.sort((a, b) => a.model.localeCompare(b.model)),
                    await effortsPromise,
                );
            }
        } catch (error) {
            logger.debug('[claudeModelList] gateway discovery failed:', error);
        }
    }

    return attachClaudeEfforts(buildStaticFallback(), await effortsPromise);
}
