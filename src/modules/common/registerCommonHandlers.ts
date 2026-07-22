import { logger } from '@/ui/logger';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { run as runDifftastic } from '@/modules/difftastic/index';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { codexModelList, type CodexModelInfo } from '@/codex/codexModelList';
import { claudeModelList, type ClaudeModelInfo } from '@/claude/claudeModelList';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import type { AgentPlaneSessionEncryptionAttestation } from '../../api/types';
import { validatePath } from './pathSecurity';

const execAsync = promisify(exec);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

interface ReadFileRequest {
    path: string;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface ListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number; // timestamp
}

interface ListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface GetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[]; // Only present for directories
}

interface GetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface CodexModelsListResponse {
    success: boolean;
    models?: CodexModelInfo[];
    error?: string;
}

interface CodexModelsListRequest {
    environmentVariables?: Record<string, string>;
}

interface ClaudeModelsListResponse {
    success: boolean;
    models?: ClaudeModelInfo[];
    error?: string;
}

interface ClaudeModelsListRequest {
    environmentVariables?: Record<string, string>;
}

interface AgentCapabilitiesListRequest {
    agent?: 'claude' | 'codex';
    environmentVariables?: Record<string, string>;
}

interface AgentCapabilityInfo {
    provider: 'claude' | 'codex';
    cliVersion?: string | null;
    models: Array<ClaudeModelInfo | CodexModelInfo>;
    defaultModel?: string | null;
    runtimeModes: string[];
    reasoningEfforts: string[];
    defaultReasoningEffort?: string | null;
    accessModes?: string[];
    claudePermissionModes?: string[];
    codexCollaborationModes?: string[];
    codexPermissionProfiles?: string[];
    permissionPresets?: string[];
    permissionModes: string[];
    approvalPolicies?: string[];
    sandboxModes?: string[];
    supportsPlanMode: boolean;
    supportsGoals: boolean;
    supportsTurnInterrupt: boolean;
    supportsApprovalRequests: boolean;
}

interface AgentCapabilitiesListResponse {
    success: boolean;
    capabilities?: AgentCapabilityInfo[];
    error?: string;
}

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
*/

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex' | 'gemini';
    token?: string;
    codexMcpServers?: Record<string, unknown>;
    codexUseBuiltInHappyMcp?: boolean;
    environmentVariables?: Record<string, string>;
    /**
     * `replace` preserves the legacy behavior for a non-empty RPC environment.
     * `overlay` adds RPC variables on top of the daemon's active local profile.
     */
    environmentVariablesMode?: EnvironmentVariablesMode;
    /** Fail spawn unless the exact child session attests this terminal protocol. */
    requiredTerminalProtocol?: 1;
}

export type EnvironmentVariablesMode = 'replace' | 'overlay';

export type SpawnSessionResult =
    | {
        type: 'success';
        sessionId: string;
        terminalProtocol?: 1;
        sessionEncryption?: AgentPlaneSessionEncryptionAttestation;
    }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

function expandedEnvironment(data?: { environmentVariables?: Record<string, string> }): Record<string, string> | undefined {
    return data?.environmentVariables
        ? expandEnvironmentVariables(data.environmentVariables, process.env)
        : undefined;
}

async function commandVersion(command: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync(command, { timeout: 5_000 });
        return stdout.toString().trim() || null;
    } catch {
        return null;
    }
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

async function buildClaudeCapabilities(env: Record<string, string> | undefined): Promise<AgentCapabilityInfo> {
    const models = await claudeModelList({ timeoutMs: 10_000, env });
    const efforts = uniqueStrings(models.flatMap((model) => model.efforts?.map((effort) => effort.id) ?? []));
    const defaultEffort = models
        .flatMap((model) => model.efforts ?? [])
        .find((effort) => effort.isDefault)?.id ?? null;
    return {
        provider: 'claude',
        cliVersion: await commandVersion('claude --version'),
        models,
        defaultModel: models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? null,
        runtimeModes: ['default', 'plan'],
        reasoningEfforts: efforts,
        defaultReasoningEffort: defaultEffort,
        claudePermissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'],
        permissionPresets: ['ask', 'auto_edits', 'full_access', 'read_only'],
        permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'],
        supportsPlanMode: true,
        supportsGoals: false,
        supportsTurnInterrupt: true,
        supportsApprovalRequests: true,
    };
}

async function probeCodexRuntimeControls(env: Record<string, string> | undefined): Promise<{
    collaborationModes: string[];
    permissionProfiles: string[];
}> {
    const client = new CodexAppServerClient(env);
    try {
        await client.connect();
        const [collaborationModes, permissionProfiles] = await Promise.all([
            client.listCollaborationModes(),
            client.listPermissionProfiles(),
        ]);
        return {
            collaborationModes: uniqueStrings(collaborationModes.map((mode) => mode.mode ?? undefined)),
            permissionProfiles: uniqueStrings(permissionProfiles.map((profile) => profile.id)),
        };
    } finally {
        await client.disconnect();
    }
}

async function buildCodexCapabilities(env: Record<string, string> | undefined): Promise<AgentCapabilityInfo> {
    const models = await codexModelList({ timeoutMs: 10_000, env });
    const efforts = uniqueStrings(models.flatMap((model) => model.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort) ?? []));
    let runtimeControls: { collaborationModes: string[]; permissionProfiles: string[] } = {
        collaborationModes: ['default', 'plan'],
        permissionProfiles: [':read-only', ':workspace', ':danger-full-access'],
    };
    try {
        const probed = await probeCodexRuntimeControls(env);
        runtimeControls = {
            collaborationModes: probed.collaborationModes.length > 0 ? probed.collaborationModes : runtimeControls.collaborationModes,
            permissionProfiles: probed.permissionProfiles.length > 0 ? probed.permissionProfiles : runtimeControls.permissionProfiles,
        };
    } catch (error) {
        logger.debug('[agent-capabilities-list] Codex runtime control probe failed:', error);
    }
    return {
        provider: 'codex',
        cliVersion: await commandVersion('codex --version'),
        models,
        defaultModel: models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? null,
        runtimeModes: runtimeControls.collaborationModes.length > 0 ? runtimeControls.collaborationModes : ['default', 'plan'],
        reasoningEfforts: efforts,
        defaultReasoningEffort: models.find((model) => model.isDefault)?.defaultReasoningEffort ?? models[0]?.defaultReasoningEffort ?? null,
        accessModes: ['read-only', 'workspace-write', 'danger-full-access'],
        codexCollaborationModes: runtimeControls.collaborationModes,
        codexPermissionProfiles: runtimeControls.permissionProfiles,
        permissionPresets: ['ask', 'auto_edits', 'full_access', 'read_only'],
        permissionModes: ['default', 'plan', 'read-only', 'safe-yolo', 'yolo', 'acceptEdits', 'bypassPermissions'],
        approvalPolicies: ['untrusted', 'on-request', 'on-failure', 'never'],
        sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
        supportsPlanMode: runtimeControls.collaborationModes.includes('plan'),
        supportsGoals: true,
        supportsTurnInterrupt: true,
        supportsApprovalRequests: true,
    };
}

/**
 * Register all RPC handlers with the session
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {

    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command);

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        if (data.cwd && data.cwd !== '/') {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
            const options: ExecOptions = {
                cwd: data.cwd === '/' ? undefined : data.cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
            };

            logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
            const { stdout, stderr } = await execAsync(data.command, options);
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
            };
            logger.debug('Shell command result:', {
                success: true,
                exitCode: 0,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
                };
                logger.debug('Shell command timed out:', {
                    success: false,
                    exitCode: result.exitCode,
                    error: 'Command timed out'
                });
                return result;
            }

            // If exec fails, it includes stdout/stderr in the error
            const result = {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed'
            };
            logger.debug('Shell command failed:', {
                success: false,
                exitCode: result.exitCode,
                error: result.error,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const buffer = await readFile(data.path);
            const content = buffer.toString('base64');
            return { success: true, content };
        } catch (error) {
            logger.debug('Failed to read file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    }, { execution: 'read-only' });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            // If expectedHash is provided (not null), verify existing file
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path);
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex');

                    if (existingHash !== data.expectedHash) {
                        return {
                            success: false,
                            error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                        };
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist but hash was provided
                    return {
                        success: false,
                        error: 'File does not exist but hash was provided'
                    };
                }
            } else {
                // expectedHash is null - expecting new file
                try {
                    await stat(data.path);
                    // File exists but we expected it to be new
                    return {
                        success: false,
                        error: 'File already exists but was expected to be new'
                    };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist - this is expected
                }
            }

            // Write the file
            const buffer = Buffer.from(data.content, 'base64');
            await writeFile(data.path, buffer);

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // List directory handler
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data) => {
        logger.debug('List directory request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const entries = await readdir(data.path, { withFileTypes: true });

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(data.path, entry.name);
                    let type: 'file' | 'directory' | 'other' = 'other';
                    let size: number | undefined;
                    let modified: number | undefined;

                    if (entry.isDirectory()) {
                        type = 'directory';
                    } else if (entry.isFile()) {
                        type = 'file';
                    }

                    try {
                        const stats = await stat(fullPath);
                        size = stats.size;
                        modified = stats.mtime.getTime();
                    } catch (error) {
                        // Ignore stat errors for individual files
                        logger.debug(`Failed to stat ${fullPath}:`, error);
                    }

                    return {
                        name: entry.name,
                        type,
                        size,
                        modified
                    };
                })
            );

            // Sort entries: directories first, then files, alphabetically
            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, entries: directoryEntries };
        } catch (error) {
            logger.debug('Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    }, { execution: 'read-only' });

    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Helper function to build tree recursively
        async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
            try {
                const stats = await stat(path);

                // Base node information
                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                };

                // If it's a directory and we haven't reached max depth, get children
                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    const entries = await readdir(path, { withFileTypes: true });
                    const children: TreeNode[] = [];

                    // Process entries in parallel, filtering out symlinks
                    await Promise.all(
                        entries.map(async (entry) => {
                            // Skip symbolic links completely
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
                                return;
                            }

                            const childPath = join(path, entry.name);
                            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
                            if (childNode) {
                                children.push(childNode);
                            }
                        })
                    );

                    // Sort children: directories first, then files, alphabetically
                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1;
                        if (a.type !== 'directory' && b.type === 'directory') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    node.children = children;
                }

                return node;
            } catch (error) {
                // Log error but continue traversal
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
                return null;
            }
        }

        try {
            // Validate maxDepth
            if (data.maxDepth < 0) {
                return { success: false, error: 'maxDepth must be non-negative' };
            }

            // Get the base name for the root node
            const baseName = data.path === '/' ? '/' : data.path.split('/').pop() || data.path;

            // Build the tree starting from the requested path
            const tree = await buildTree(data.path, baseName, 0);

            if (!tree) {
                return { success: false, error: 'Failed to access the specified path' };
            }

            return { success: true, tree };
        } catch (error) {
            logger.debug('Failed to get directory tree:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
        }
    }, { execution: 'read-only' });

    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            const result = await runRipgrep(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });

    // Codex models list handler - dynamic model discovery from local Codex CLI.
    rpcHandlerManager.registerHandler<CodexModelsListRequest, CodexModelsListResponse>('codex-models-list', async (data) => {
        try {
            const env = expandedEnvironment(data);
            const models = await codexModelList({ timeoutMs: 10_000, env });
            return { success: true, models };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list Codex models' };
        }
    }, { execution: 'read-only' });

    // Claude models list handler - gateway discovery plus Claude Code alias fallback.
    rpcHandlerManager.registerHandler<ClaudeModelsListRequest, ClaudeModelsListResponse>('claude-models-list', async (data) => {
        try {
            const env = expandedEnvironment(data);
            const models = await claudeModelList({ timeoutMs: 10_000, env });
            return { success: true, models };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list Claude models' };
        }
    }, { execution: 'read-only' });

    rpcHandlerManager.registerHandler<AgentCapabilitiesListRequest, AgentCapabilitiesListResponse>('agent-capabilities-list', async (data) => {
        try {
            const env = expandedEnvironment(data);
            const agents = data?.agent ? [data.agent] : ['claude', 'codex'] as const;
            const capabilities: AgentCapabilityInfo[] = [];
            for (const agent of agents) {
                capabilities.push(agent === 'claude'
                    ? await buildClaudeCapabilities(env)
                    : await buildCodexCapabilities(env));
            }
            return { success: true, capabilities };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list agent capabilities' };
        }
    }, { execution: 'read-only' });
}
