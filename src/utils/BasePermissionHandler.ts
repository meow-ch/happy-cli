/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import {
    AgentPlanDecision,
    AgentPlanDecisionAction,
    AgentQuestionnaire,
    AgentQuestionnaireAnswerMap,
    AgentState
} from "@/api/types";

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export interface QuestionnaireResponse {
    id: string;
    answers?: AgentQuestionnaireAnswerMap;
    status?: 'answered' | 'expired' | 'canceled';
}

export interface PendingQuestionnaireRequest {
    resolve: (value: QuestionnaireResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    questionnaire: AgentQuestionnaire;
}

export interface QuestionnaireResult {
    answers: AgentQuestionnaireAnswerMap;
    status: 'answered' | 'expired' | 'canceled';
}

export interface PlanDecisionResponse {
    id: string;
    decision: AgentPlanDecisionAction;
    feedback?: string;
}

export interface PendingPlanDecisionRequest {
    resolve: (value: PlanDecisionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    planDecision: AgentPlanDecision;
}

export interface PlanDecisionResult {
    decision: AgentPlanDecisionAction;
    feedback?: string;
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected pendingQuestionnaires = new Map<string, PendingQuestionnaireRequest>();
    protected pendingPlanDecisions = new Map<string, PendingPlanDecisionRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    constructor(session: ApiSessionClient) {
        this.session = session;
        this.setupRpcHandler();
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Permission request not found or already resolved`);
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);

                // Resolve the permission request
                const result: PermissionResult = response.approved
                    ? { decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved' }
                    : { decision: response.decision === 'denied' ? 'denied' : 'abort' };

                pending.resolve(result);

                // Move request to completed in agent state
                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    let res = {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: response.approved ? 'approved' : 'denied',
                                decision: result.decision
                            }
                        }
                    } satisfies AgentState;
                    return res;
                });

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );

        this.session.rpcHandlerManager.registerHandler<QuestionnaireResponse, void>(
            'questionnaire',
            async (response) => {
                const pending = this.pendingQuestionnaires.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Questionnaire request not found or already resolved`);
                    return;
                }

                this.pendingQuestionnaires.delete(response.id);

                const result: QuestionnaireResult = {
                    answers: normalizeQuestionnaireAnswers(response.answers),
                    status: response.status ?? 'answered',
                };

                pending.resolve(result);

                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    return {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: result.status,
                                answers: result.answers,
                            }
                        }
                    } satisfies AgentState;
                });

                logger.debug(`${this.getLogPrefix()} Questionnaire ${result.status} for ${pending.toolName}`);
            }
        );

        this.session.rpcHandlerManager.registerHandler<PlanDecisionResponse, void>(
            'plan-decision',
            async (response) => {
                const pending = this.pendingPlanDecisions.get(response.id);
                if (!pending) {
                    logger.debug(`${this.getLogPrefix()} Plan decision request not found or already resolved`);
                    return;
                }

                this.pendingPlanDecisions.delete(response.id);

                const result: PlanDecisionResult = {
                    decision: response.decision === 'approve' ? 'approve' : 'stay_in_plan',
                    feedback: typeof response.feedback === 'string' ? response.feedback : undefined,
                };

                pending.resolve(result);

                this.session.updateAgentState((currentState) => {
                    const request = currentState.requests?.[response.id];
                    if (!request) return currentState;

                    const { [response.id]: _, ...remainingRequests } = currentState.requests || {};

                    return {
                        ...currentState,
                        requests: remainingRequests,
                        completedRequests: {
                            ...currentState.completedRequests,
                            [response.id]: {
                                ...request,
                                completedAt: Date.now(),
                                status: result.decision === 'approve' ? 'approved' : 'stayed_in_plan',
                                planDecisionResult: result.decision,
                                feedback: result.feedback,
                            }
                        }
                    } satisfies AgentState;
                });

                logger.debug(`${this.getLogPrefix()} Plan decision ${result.decision} for ${pending.toolName}`);
            }
        );
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [toolCallId]: {
                    kind: 'permission',
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now()
                }
            }
        }));
    }

    protected addPendingQuestionnaireToState(requestId: string, toolName: string, questionnaire: AgentQuestionnaire): void {
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [requestId]: {
                    kind: 'questionnaire',
                    tool: toolName,
                    arguments: questionnaire,
                    questionnaire,
                    createdAt: Date.now()
                }
            }
        }));
    }

    protected addPendingPlanDecisionToState(requestId: string, toolName: string, planDecision: AgentPlanDecision): void {
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [requestId]: {
                    kind: 'plan_decision',
                    tool: toolName,
                    arguments: planDecision,
                    planDecision,
                    createdAt: Date.now()
                }
            }
        }));
    }

    async handleQuestionnaireRequest(
        requestId: string,
        toolName: string,
        questionnaire: AgentQuestionnaire
    ): Promise<QuestionnaireResult> {
        return new Promise<QuestionnaireResult>((resolve, reject) => {
            this.pendingQuestionnaires.set(requestId, {
                resolve,
                reject,
                toolName,
                questionnaire
            });

            this.addPendingQuestionnaireToState(requestId, toolName, questionnaire);

            logger.debug(`${this.getLogPrefix()} Questionnaire request sent for ${toolName} (${requestId})`);
        });
    }

    async handlePlanDecisionRequest(
        requestId: string,
        toolName: string,
        planDecision: AgentPlanDecision
    ): Promise<PlanDecisionResult> {
        return new Promise<PlanDecisionResult>((resolve, reject) => {
            this.pendingPlanDecisions.set(requestId, {
                resolve,
                reject,
                toolName,
                planDecision
            });

            this.addPendingPlanDecisionToState(requestId, toolName, planDecision);

            logger.debug(`${this.getLogPrefix()} Plan decision request sent for ${toolName} (${requestId})`);
        });
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            const pendingQuestionnaireSnapshot = Array.from(this.pendingQuestionnaires.entries());
            const pendingPlanDecisionSnapshot = Array.from(this.pendingPlanDecisions.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed
            this.pendingQuestionnaires.clear();
            this.pendingPlanDecisions.clear();

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
            }

            for (const [id, pending] of pendingQuestionnaireSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending questionnaire ${id}:`, err);
                }
            }

            for (const [id, pending] of pendingPlanDecisionSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending plan decision ${id}:`, err);
                }
            }

            // Clear requests in agent state
            this.session.updateAgentState((currentState) => {
                const pendingRequests = currentState.requests || {};
                const completedRequests = { ...currentState.completedRequests };

                // Move all pending to completed as canceled
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedRequests[id] = {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason: 'Session reset'
                    };
                }

                return {
                    ...currentState,
                    requests: {},
                    completedRequests
                };
            });

            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
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
