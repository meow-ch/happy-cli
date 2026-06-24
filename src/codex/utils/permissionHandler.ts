/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 * Extends BasePermissionHandler with Codex-specific configuration.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';
import type { PermissionPreset } from '@/api/types';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Codex-specific permission handler.
 */
export class CodexPermissionHandler extends BasePermissionHandler {
    private permissionPreset: PermissionPreset | undefined;

    constructor(session: ApiSessionClient) {
        super(session);
    }

    setPermissionPreset(preset: PermissionPreset | undefined): void {
        this.permissionPreset = preset;
    }

    protected getLogPrefix(): string {
        return '[Codex]';
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        if (this.permissionPreset === 'auto_edits' && toolName === 'CodexPatch') {
            this.addPendingRequestToState(toolCallId, toolName, input);
            this.session.updateAgentState((currentState) => {
                const request = currentState.requests?.[toolCallId];
                if (!request) return currentState;
                const { [toolCallId]: _, ...remainingRequests } = currentState.requests || {};
                return {
                    ...currentState,
                    requests: remainingRequests,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [toolCallId]: {
                            ...request,
                            completedAt: Date.now(),
                            status: 'approved',
                            decision: 'approved',
                        },
                    },
                };
            });
            logger.debug(`${this.getLogPrefix()} Auto-approved Codex file change for auto_edits preset (${toolCallId})`);
            return { decision: 'approved' };
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }
}
