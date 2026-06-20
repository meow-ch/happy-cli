import type { QueryOptions } from '@/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/**
 * Map any legacy PermissionMode to a Claude-compatible mode.
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → default (ask for permissions)
 * - read-only → default (Claude doesn't support read-only)
 *
 * Claude modes pass through unchanged:
 * - default, acceptEdits, auto, bypassPermissions, dontAsk, plan
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}
