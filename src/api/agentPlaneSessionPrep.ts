import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type PrepareAgentPlaneSessionFile = {
    path: string;
    content: string;
};

export type PrepareAgentPlaneSessionRequest = {
    conversationId?: string;
    directory?: string;
    files: PrepareAgentPlaneSessionFile[];
};

export type PrepareAgentPlaneSessionResponse = {
    type: 'success';
    directory: string;
    filesWritten: number;
};

// Keep this allowlist in sync with the Agent Plane secure session prep bundle.
const AGENT_PLANE_SESSION_ALLOWED_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.mcp.json', 'conversation-history.md']);
const AGENT_PLANE_SESSION_MAX_FILES = 4;
const AGENT_PLANE_SESSION_MAX_FILE_BYTES = 2 * 1024 * 1024;
const AGENT_PLANE_CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{8,120}$/;

function getAgentPlaneSessionRoot(): string {
    return resolve(tmpdir(), 'conversations');
}

function assertAgentPlaneConversationId(conversationId: string): string {
    if (!AGENT_PLANE_CONVERSATION_ID_PATTERN.test(conversationId)) {
        throw new Error(`Invalid Agent Plane conversation ID: ${conversationId}`);
    }
    return conversationId;
}

function assertAgentPlaneSessionDirectory(directory: string): string {
    const allowedRoot = getAgentPlaneSessionRoot();
    const resolvedDirectory = resolve(directory);
    if (resolvedDirectory !== allowedRoot && !resolvedDirectory.startsWith(allowedRoot + sep)) {
        throw new Error(`Agent Plane session directory must be under ${allowedRoot}`);
    }
    return resolvedDirectory;
}

function assertRelativeSessionFilePath(directory: string, filePath: string): string {
    if (!filePath || isAbsolute(filePath) || filePath.split(/[\\/]+/).includes('..')) {
        throw new Error(`Invalid Agent Plane session file path: ${filePath}`);
    }
    if (!AGENT_PLANE_SESSION_ALLOWED_FILES.has(filePath)) {
        throw new Error(`Unsupported Agent Plane session file path: ${filePath}`);
    }
    const resolved = resolve(directory, filePath);
    if (!resolved.startsWith(directory + sep)) {
        throw new Error(`Agent Plane session file escapes directory: ${filePath}`);
    }
    return resolved;
}

function resolveAgentPlaneSessionDirectory(params: PrepareAgentPlaneSessionRequest): string {
    if (typeof params?.conversationId === 'string' && params.conversationId.trim()) {
        return join(getAgentPlaneSessionRoot(), assertAgentPlaneConversationId(params.conversationId.trim()));
    }
    if (typeof params?.directory === 'string' && params.directory.trim()) {
        return assertAgentPlaneSessionDirectory(params.directory);
    }
    throw new Error('conversationId is required');
}

async function assertPlainDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Agent Plane session path is not a plain directory: ${directory}`);
    }
}

async function writeSessionFileNoFollow(target: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > AGENT_PLANE_SESSION_MAX_FILE_BYTES) {
        throw new Error(`Agent Plane session file is too large: ${bytes} bytes`);
    }
    const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
    );
    try {
        await handle.writeFile(content, { encoding: 'utf8' });
    } finally {
        await handle.close();
    }
}

export async function prepareAgentPlaneSession(params: PrepareAgentPlaneSessionRequest): Promise<PrepareAgentPlaneSessionResponse> {
    const directory = resolveAgentPlaneSessionDirectory(params);
    if (!Array.isArray(params.files)) {
        throw new Error('files must be an array');
    }
    if (params.files.length > AGENT_PLANE_SESSION_MAX_FILES) {
        throw new Error(`Too many Agent Plane session files: ${params.files.length}`);
    }
    await mkdir(getAgentPlaneSessionRoot(), { recursive: true, mode: 0o700 });
    await assertPlainDirectory(getAgentPlaneSessionRoot());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPlainDirectory(directory);
    let filesWritten = 0;
    for (const file of params.files) {
        const target = assertRelativeSessionFilePath(directory, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeSessionFileNoFollow(target, String(file.content ?? ''));
        filesWritten += 1;
    }
    return { type: 'success', directory, filesWritten };
}

export const __testAgentPlaneSessionPrep = {
    assertAgentPlaneConversationId,
    assertAgentPlaneSessionDirectory,
    assertRelativeSessionFilePath,
    prepareAgentPlaneSession,
    resolveAgentPlaneSessionDirectory,
};
