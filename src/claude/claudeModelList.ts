export interface ClaudeModelInfo {
    model: string;
    displayName?: string;
    description?: string;
    isDefault?: boolean;
    source?: 'builtin' | 'gateway' | 'custom';
}

type ClaudeModelListOptions = {
    timeoutMs?: number;
    env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
    const value = env[key]?.trim();
    return value ? value : undefined;
}

function buildBuiltinModels(env: Record<string, string | undefined>): ClaudeModelInfo[] {
    const profileModel = envValue(env, 'ANTHROPIC_MODEL');
    const opusModel = envValue(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL');
    const sonnetModel = envValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL');
    const haikuModel = envValue(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL');

    return [
        {
            model: 'default',
            displayName: 'Default (recommended)',
            description: profileModel
                ? `${profileModel} · Profile default`
                : 'Use Claude Code\'s recommended default model',
            isDefault: true,
            source: 'builtin',
        },
        {
            model: 'opus',
            displayName: 'Opus',
            description: opusModel ? `${opusModel} · Most capable` : 'Most capable for complex work',
            source: 'builtin',
        },
        {
            model: 'sonnet',
            displayName: 'Sonnet',
            description: sonnetModel ? `${sonnetModel} · Best everyday model` : 'Best for everyday tasks',
            source: 'builtin',
        },
        {
            model: 'haiku',
            displayName: 'Haiku',
            description: haikuModel ? `${haikuModel} · Fastest` : 'Fastest for quick answers',
            source: 'builtin',
        },
    ];
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

function isDiscoverableClaudeModel(model: string): boolean {
    const lower = model.toLowerCase();
    return lower.startsWith('claude') || lower.startsWith('anthropic');
}

function addCustomModel(models: ClaudeModelInfo[], model: string | undefined, displayName?: string, description?: string) {
    const value = model?.trim();
    if (!value) return;
    models.push({
        model: value,
        displayName: displayName || value,
        description,
        source: 'custom',
    });
}

function addCustomModelOptions(models: ClaudeModelInfo[], env: Record<string, string | undefined>) {
    addCustomModel(
        models,
        envValue(env, 'ANTHROPIC_MODEL'),
        envValue(env, 'ANTHROPIC_MODEL_NAME'),
        envValue(env, 'ANTHROPIC_MODEL_DESCRIPTION') || 'Profile model'
    );
    addCustomModel(
        models,
        envValue(env, 'ANTHROPIC_SMALL_FAST_MODEL'),
        envValue(env, 'ANTHROPIC_SMALL_FAST_MODEL_NAME'),
        envValue(env, 'ANTHROPIC_SMALL_FAST_MODEL_DESCRIPTION') || 'Profile small/fast model'
    );
    addCustomModel(
        models,
        envValue(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION'),
        envValue(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME'),
        envValue(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION') || 'Custom Claude Code model option'
    );
}

function dedupeModels(models: ClaudeModelInfo[]): ClaudeModelInfo[] {
    const byModel = new Map<string, ClaudeModelInfo>();
    for (const model of models) {
        if (!model.model) continue;
        if (!byModel.has(model.model)) {
            byModel.set(model.model, model);
            continue;
        }

        const existing = byModel.get(model.model)!;
        byModel.set(model.model, {
            ...existing,
            ...model,
            isDefault: existing.isDefault || model.isDefault,
            description: model.description || existing.description,
            displayName: model.displayName || existing.displayName,
        });
    }
    return [...byModel.values()];
}

async function fetchJsonWithTimeout(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            headers,
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            const detail = text.trim() ? `: ${text.trim().slice(0, 500)}` : '';
            throw new Error(`Claude models endpoint returned HTTP ${response.status}${detail}`);
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(`Claude models endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    } finally {
        clearTimeout(timer);
    }
}

async function fetchGatewayModels(
    baseUrl: string,
    env: Record<string, string | undefined>,
    timeoutMs: number
): Promise<ClaudeModelInfo[]> {
    const headers = buildHeaders(env);
    const models: ClaudeModelInfo[] = [];
    let afterId: string | null = null;

    for (let page = 0; page < 20; page++) {
        const url = new URL(`${normalizeBaseUrl(baseUrl)}/v1/models`);
        url.searchParams.set('limit', '1000');
        if (afterId) url.searchParams.set('after_id', afterId);

        const body = await fetchJsonWithTimeout(url, headers, timeoutMs);
        const data = (body as { data?: unknown })?.data;
        if (Array.isArray(data)) {
            for (const item of data) {
                const model = normalizeModelInfo(item);
                if (model && isDiscoverableClaudeModel(model.model)) {
                    models.push(model);
                }
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
 * List Claude models for the selected profile.
 *
 * Claude Code does not expose a machine-readable CLI equivalent of `/model`.
 * For Anthropic-compatible gateways it discovers models from `/v1/models`;
 * otherwise we return Claude Code aliases plus any pinned profile models.
 */
export async function claudeModelList(opts?: ClaudeModelListOptions): Promise<ClaudeModelInfo[]> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env: Record<string, string | undefined> = { ...process.env, ...opts?.env };

    const models: ClaudeModelInfo[] = [
        ...buildBuiltinModels(env),
    ];
    addCustomModelOptions(models, env);

    const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL');
    const hasApiKey = !!envValue(env, 'ANTHROPIC_API_KEY');
    const discoveryBaseUrl = baseUrl || (hasApiKey ? 'https://api.anthropic.com' : undefined);

    if (!discoveryBaseUrl) {
        return dedupeModels(models);
    }

    try {
        const gatewayModels = await fetchGatewayModels(discoveryBaseUrl, env, timeoutMs);
        return dedupeModels([
            ...models,
            ...gatewayModels.sort((a, b) => a.model.localeCompare(b.model)),
        ]);
    } catch {
        // Model discovery is best-effort. Claude Code itself can still accept aliases
        // or pinned profile models when a gateway does not expose /v1/models.
        return dedupeModels(models);
    }
}
