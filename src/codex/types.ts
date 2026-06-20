/**
 * Type definitions for Codex MCP integration
 */

export interface CodexSessionConfig {
    prompt: string;
    'approval-policy'?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    'base-instructions'?: string;
    collaboration_mode?: 'default' | 'plan';
    permissions?: string;
    config?: Record<string, any>;
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: string;
    profile?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    model_reasoning_effort?: string;
}

export interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}
