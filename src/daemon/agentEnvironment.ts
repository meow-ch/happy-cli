import type { EnvironmentVariablesMode, SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';

type Agent = NonNullable<SpawnSessionOptions['agent']>;

export interface BuildAgentEnvironmentOptions {
    agent: Agent;
    environmentVariables?: Record<string, string>;
    environmentVariablesMode?: EnvironmentVariablesMode;
    authenticationEnvironmentVariables?: Record<string, string>;
    runtimeEnvironmentVariables?: Record<string, string>;
    processEnvironment?: NodeJS.ProcessEnv;
    loadLocalProfileEnvironment: (agent: Agent) => Promise<Record<string, string>>;
    logExpansion?: boolean;
}

export interface BuiltAgentEnvironment {
    /** Variables added on top of the daemon process environment. */
    extraEnvironmentVariables: Record<string, string>;
    /** The exact environment passed to a probe or spawned child process. */
    effectiveEnvironment: NodeJS.ProcessEnv;
    profileSource: 'local' | 'request' | 'local_overlay';
}

/**
 * Build the environment used by both provider readiness probes and spawned
 * agent processes.
 *
 * Compatibility is deliberate: an omitted mode retains the historical
 * behavior where a non-empty RPC environment replaces the active local
 * profile. Callers that are only supplying per-session additions must opt in
 * to `overlay` so local credentials remain present.
 */
export async function buildAgentEnvironment(
    options: BuildAgentEnvironmentOptions,
): Promise<BuiltAgentEnvironment> {
    const processEnvironment = options.processEnvironment ?? process.env;
    const environmentVariablesMode = options.environmentVariablesMode ?? 'replace';
    const requestedEnvironment = options.environmentVariables ?? {};
    const hasRequestedEnvironment = Object.keys(requestedEnvironment).length > 0;

    let profileEnvironment: Record<string, string>;
    let profileSource: BuiltAgentEnvironment['profileSource'];
    if (environmentVariablesMode === 'overlay') {
        const localProfileEnvironment = await options.loadLocalProfileEnvironment(options.agent);
        profileEnvironment = {
            ...localProfileEnvironment,
            ...requestedEnvironment,
        };
        profileSource = 'local_overlay';
    } else if (hasRequestedEnvironment) {
        profileEnvironment = { ...requestedEnvironment };
        profileSource = 'request';
    } else {
        profileEnvironment = await options.loadLocalProfileEnvironment(options.agent);
        profileSource = 'local';
    }

    // Runtime settings override profile settings, while an explicitly passed
    // authentication token remains the final authority.
    const extraEnvironmentVariables = expandEnvironmentVariables(
        {
            ...profileEnvironment,
            ...(options.runtimeEnvironmentVariables ?? {}),
            ...(options.authenticationEnvironmentVariables ?? {}),
        },
        processEnvironment,
        { log: options.logExpansion !== false },
    );

    return {
        extraEnvironmentVariables,
        effectiveEnvironment: {
            ...processEnvironment,
            ...extraEnvironmentVariables,
        },
        profileSource,
    };
}
