/**
 * Permission Handler for canCallTool integration
 * 
 * Replaces the MCP permission server with direct SDK integration.
 * Handles tool permission requests, responses, and state management.
 */

import { isDeepStrictEqual } from 'node:util';
import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PermissionResult } from "../sdk/types";
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from "../sdk/prompts";
import { Session } from "../session";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { delay } from "@/utils/time";
import type {
    AgentQuestionnaire,
    AgentQuestionnaireAnswerMap,
    AgentQuestionnaireQuestion
} from "@/api/types";

interface PermissionResponse {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    receivedAt?: number;
}


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

interface QuestionnaireResponse {
    id: string;
    answers?: AgentQuestionnaireAnswerMap;
    status?: 'answered' | 'expired' | 'canceled';
}

interface QuestionnaireResult {
    answers: AgentQuestionnaireAnswerMap;
    status: 'answered' | 'expired' | 'canceled';
}

interface PendingQuestionnaireRequest {
    resolve: (value: QuestionnaireResult) => void;
    reject: (error: Error) => void;
    input: unknown;
    questionnaire: AgentQuestionnaire;
}

export class PermissionHandler {
    private toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private pendingQuestionnaires = new Map<string, PendingQuestionnaireRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;

    constructor(session: Session) {
        this.session = session;
        this.setupClientHandler();
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        // Update allowed tools
        if (response.allowTools && response.allowTools.length > 0) {
            response.allowTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
        }

        // Handle 
        if (pending.toolName === 'exit_plan_mode' || pending.toolName === 'ExitPlanMode') {
            // Handle exit_plan_mode specially
            logger.debug('Plan mode result received', response);
            if (response.approved) {
                logger.debug('Plan approved - injecting PLAN_FAKE_RESTART');
                // Inject the approval message at the beginning of the queue
                if (response.mode && ['default', 'acceptEdits', 'bypassPermissions'].includes(response.mode)) {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: response.mode });
                } else {
                    this.session.queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'default' });
                }
                pending.resolve({ behavior: 'deny', message: PLAN_FAKE_REJECT });
            } else {
                pending.resolve({ behavior: 'deny', message: response.reason || 'Plan rejected' });
            }
        } else {
            const approvedInput = this.getApprovedInput(response, pending.input);

            // Handle default case for all other tools
            const result: PermissionResult = response.approved
                ? { behavior: 'allow', updatedInput: approvedInput }
                : { behavior: 'deny', message: response.reason || `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` };

            pending.resolve(result);
        }
    }

    private getApprovedInput(response: PermissionResponse, fallbackInput: unknown): Record<string, unknown> {
        if (response.approved && response.updatedInput && typeof response.updatedInput === 'object' && !Array.isArray(response.updatedInput)) {
            return response.updatedInput;
        }
        if (fallbackInput && typeof fallbackInput === 'object' && !Array.isArray(fallbackInput)) {
            return fallbackInput as Record<string, unknown>;
        }
        return {};
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }): Promise<PermissionResult> => {

        if (toolName === 'AskUserQuestion') {
            let toolCallId = this.resolveToolCallId(toolName, input);
            if (!toolCallId) {
                await delay(1000);
                toolCallId = this.resolveToolCallId(toolName, input);
                if (!toolCallId) {
                    throw new Error(`Could not resolve tool call ID for ${toolName}`);
                }
            }

            const result = await this.handleQuestionnaireRequest(toolCallId, input, options.signal);
            return {
                behavior: 'allow',
                updatedInput: this.buildClaudeQuestionnaireUpdatedInput(input, result.answers)
            };
        }

        // Check if tool is explicitly allowed
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                // Check literal matches
                if (this.allowedBashLiterals.has(inputObj.command)) {
                    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                }
                // Check prefix matches
                for (const prefix of this.allowedBashPrefixes) {
                    if (inputObj.command.startsWith(prefix)) {
                        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
                    }
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        if (this.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        if (this.permissionMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        let toolCallId = this.resolveToolCallId(toolName, input);
        if (!toolCallId) { // What if we got permission before tool call
            await delay(1000);
            toolCallId = this.resolveToolCallId(toolName, input);
            if (!toolCallId) {
                throw new Error(`Could not resolve tool call ID for ${toolName}`);
            }
        }
        return this.handlePermissionRequest(toolCallId, toolName, input, options.signal);
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            this.pendingRequests.set(id, {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }
            
            // Send push notification
            this.session.api.push().sendToAllDevices(
                'Permission Request',
                `Claude wants to ${getToolName(toolName)}`,
                {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: toolName,
                    type: 'permission_request'
                }
            );

            // Update agent state
            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }

    private async handleQuestionnaireRequest(
        id: string,
        input: unknown,
        signal: AbortSignal
    ): Promise<QuestionnaireResult> {
        const questionnaire = normalizeClaudeQuestionnaire(input);

        return new Promise<QuestionnaireResult>((resolve, reject) => {
            const abortHandler = () => {
                this.pendingQuestionnaires.delete(id);
                reject(new Error('Questionnaire request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            this.pendingQuestionnaires.set(id, {
                resolve: (result: QuestionnaireResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                input,
                questionnaire
            });

            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }

            this.session.api.push().sendToAllDevices(
                'Question',
                questionnaire.questions[0]?.question || 'Claude needs your input',
                {
                    sessionId: this.session.client.sessionId,
                    requestId: id,
                    tool: 'AskUserQuestion',
                    type: 'questionnaire_request'
                }
            );

            this.session.client.updateAgentState((currentState) => ({
                ...currentState,
                requests: {
                    ...currentState.requests,
                    [id]: {
                        kind: 'questionnaire',
                        tool: 'AskUserQuestion',
                        arguments: questionnaire,
                        questionnaire,
                        createdAt: Date.now()
                    }
                }
            }));

            logger.debug(`Questionnaire request sent for tool call ${id}: AskUserQuestion`);
        });
    }

    private buildClaudeQuestionnaireUpdatedInput(input: unknown, answers: AgentQuestionnaireAnswerMap): Record<string, unknown> {
        const inputObj = input && typeof input === 'object' && !Array.isArray(input)
            ? input as Record<string, unknown>
            : {};
        const questionnaire = normalizeClaudeQuestionnaire(input);
        const claudeAnswers: Record<string, string | string[]> = {};

        for (const question of questionnaire.questions) {
            const values = answers[question.id]?.answers ?? [];
            const key = question.question || question.header || question.id;
            claudeAnswers[key] = question.multiSelect ? values : (values[0] ?? '');
        }

        return {
            ...inputObj,
            questions: inputObj.questions,
            answers: claudeAnswers
        };
    }


    /**
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);
        
        if (!match) {
            return;
        }

        const command = match[1];
        
        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
    }

    /**
     * Resolves tool call ID based on tool name and input
     */
    private resolveToolCallId(name: string, args: any): string | null {
        // Search in reverse (most recent first)
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && isDeepStrictEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    /**
     * Handles messages to track tool calls
     */
    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = this.toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {

        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Always abort exit_plan_mode
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        for (const [, pending] of this.pendingQuestionnaires.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingQuestionnaires.clear();

        // Move all pending requests to completedRequests with canceled status
        this.session.client.updateAgentState((currentState) => {
            const pendingRequests = currentState.requests || {};
            const completedRequests = { ...currentState.completedRequests };

            // Move each pending request to completed with canceled status
            for (const [id, request] of Object.entries(pendingRequests)) {
                completedRequests[id] = {
                    ...request,
                    completedAt: Date.now(),
                    status: 'canceled',
                    reason: 'Session switched to local mode'
                };
            }

            return {
                ...currentState,
                requests: {}, // Clear all pending requests
                completedRequests
            };
        });
    }

    /**
     * Sets up the client handler for permission responses
     */
    private setupClientHandler(): void {
        this.session.client.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (message) => {
            logger.debug(`Permission response: ${JSON.stringify(message)}`);

            const id = message.id;
            const pending = this.pendingRequests.get(id);

            if (!pending) {
                logger.debug('Permission request not found or already resolved');
                return;
            }

            // Store the response with timestamp
            this.responses.set(id, { ...message, receivedAt: Date.now() });
            this.pendingRequests.delete(id);

            // Handle the permission response based on tool type
            this.handlePermissionResponse(message, pending);

            // Move processed request to completedRequests
            this.session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                let r = { ...currentState.requests };
                delete r[id];
                return {
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            arguments: this.getApprovedInput(message, request.arguments),
                            completedAt: Date.now(),
                            status: message.approved ? 'approved' : 'denied',
                            reason: message.reason,
                            mode: message.mode,
                            allowTools: message.allowTools
                        }
                    }
                };
            });
        });

        this.session.client.rpcHandlerManager.registerHandler<QuestionnaireResponse, void>('questionnaire', async (message) => {
            logger.debug(`Questionnaire response: ${JSON.stringify({
                id: message.id,
                status: message.status,
                answerKeys: message.answers ? Object.keys(message.answers) : []
            })}`);

            const id = message.id;
            const pending = this.pendingQuestionnaires.get(id);

            if (!pending) {
                logger.debug('Questionnaire request not found or already resolved');
                return;
            }

            this.pendingQuestionnaires.delete(id);
            const result: QuestionnaireResult = {
                answers: normalizeQuestionnaireAnswers(message.answers),
                status: message.status ?? 'answered'
            };
            pending.resolve(result);

            this.session.client.updateAgentState((currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                let r = { ...currentState.requests };
                delete r[id];
                return {
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: result.status,
                            answers: result.answers
                        }
                    }
                };
            });
        });
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}

function normalizeClaudeQuestionnaire(input: unknown): AgentQuestionnaire {
    const inputObj = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    const rawQuestions = Array.isArray(inputObj.questions) && inputObj.questions.length > 0
        ? inputObj.questions
        : [inputObj];

    const questions = rawQuestions.map((question, index) => normalizeClaudeQuestion(question, index));

    return {
        provider: 'claude',
        autoResolutionMs: typeof inputObj.autoResolutionMs === 'number' ? inputObj.autoResolutionMs : null,
        questions
    };
}

function normalizeClaudeQuestion(value: unknown, index: number): AgentQuestionnaireQuestion {
    const question = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const header = stringOrNull(question.header);
    const text = stringOrNull(question.question) ?? header ?? `Question ${index + 1}`;
    const id = stringOrNull(question.id) ?? text;
    const options = Array.isArray(question.options)
        ? question.options
            .map(normalizeQuestionnaireOption)
            .filter((option): option is { label: string; description: string | null } => option !== null)
        : null;

    return {
        id,
        header,
        question: text,
        options,
        isOther: booleanFlag(question.isOther)
            || booleanFlag(question.allowOther)
            || booleanFlag(question.allowCustom)
            || booleanFlag(question.allow_custom),
        isSecret: booleanFlag(question.isSecret) || booleanFlag(question.secret),
        multiSelect: booleanFlag(question.multiSelect) || booleanFlag(question.multi_select)
    };
}

function normalizeQuestionnaireOption(value: unknown): { label: string; description: string | null } | null {
    if (typeof value === 'string') {
        const label = value.trim();
        return label ? { label, description: null } : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const option = value as Record<string, unknown>;
    const label = stringOrNull(option.label) ?? stringOrNull(option.value);
    if (!label) return null;
    return {
        label,
        description: stringOrNull(option.description)
    };
}

function normalizeQuestionnaireAnswers(value: AgentQuestionnaireAnswerMap | undefined): AgentQuestionnaireAnswerMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized: AgentQuestionnaireAnswerMap = {};
    for (const [key, answer] of Object.entries(value)) {
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
        const rawAnswers = Array.isArray(answer.answers) ? answer.answers : [];
        normalized[key] = {
            answers: rawAnswers
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
        };
    }
    return normalized;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanFlag(value: unknown): boolean {
    return value === true;
}
