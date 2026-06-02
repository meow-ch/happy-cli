import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export type PrepareAgentPlaneSessionFile = {
    path: string;
    content: string;
};

export type PrepareAgentPlaneSessionRequest = {
    directory: string;
    files: PrepareAgentPlaneSessionFile[];
};

export type PrepareAgentPlaneSessionResponse = {
    type: 'success';
    directory: string;
    filesWritten: number;
};

const AGENT_PLANE_SESSION_ALLOWED_FILES = new Set(['AGENTS.md', 'CLAUDE.md', '.mcp.json']);
const AGENT_PLANE_SESSION_MAX_FILES = 4;
const AGENT_PLANE_SESSION_MAX_FILE_BYTES = 2 * 1024 * 1024;

function assertAgentPlaneSessionDirectory(directory: string): string {
    const allowedRoot = resolve(tmpdir(), 'conversations');
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
    const directory = assertAgentPlaneSessionDirectory(params?.directory);
    if (!Array.isArray(params.files)) {
        throw new Error('files must be an array');
    }
    if (params.files.length > AGENT_PLANE_SESSION_MAX_FILES) {
        throw new Error(`Too many Agent Plane session files: ${params.files.length}`);
    }
    await mkdir(resolve(tmpdir(), 'conversations'), { recursive: true, mode: 0o700 });
    await assertPlainDirectory(resolve(tmpdir(), 'conversations'));
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
    assertAgentPlaneSessionDirectory,
    assertRelativeSessionFilePath,
    prepareAgentPlaneSession,
};
