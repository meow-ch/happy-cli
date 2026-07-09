/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export type GoalCommandAction = 'start' | 'view' | 'pause' | 'resume' | 'clear';

export interface GoalCommandResult {
    isGoal: boolean;
    action?: GoalCommandAction;
    objective?: string;
    originalMessage: string;
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'goal' | null;
    originalMessage?: string;
    goal?: {
        action: GoalCommandAction;
        objective?: string;
    };
}

/**
 * Parse /compact command
 * Matches messages starting with "/compact " or exactly "/compact"
 */
export function parseCompact(message: string): CompactCommandResult {
    const trimmed = message.trim();
    
    if (trimmed === '/compact') {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    if (trimmed.startsWith('/compact ')) {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    return {
        isCompact: false,
        originalMessage: message
    };
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();
    
    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Parse /goal command
 * Matches exactly "/goal" or messages starting with "/goal ".
 */
export function parseGoal(message: string): GoalCommandResult {
    const trimmed = message.trim();

    if (trimmed === '/goal') {
        return {
            isGoal: true,
            action: 'view',
            originalMessage: trimmed
        };
    }

    if (!trimmed.startsWith('/goal ')) {
        return {
            isGoal: false,
            originalMessage: message
        };
    }

    const argument = trimmed.slice('/goal '.length).trim();
    if (argument === 'pause' || argument === 'resume' || argument === 'clear') {
        return {
            isGoal: true,
            action: argument,
            originalMessage: trimmed
        };
    }

    return {
        isGoal: true,
        action: 'start',
        objective: argument,
        originalMessage: trimmed
    };
}

export function formatGoalCommand(command: { action?: string; objective?: string } | undefined | null): string | null {
    if (!command || typeof command !== 'object') return null;
    if (command.action === 'view') return '/goal';
    if (command.action === 'pause' || command.action === 'resume' || command.action === 'clear') {
        return `/goal ${command.action}`;
    }
    if (command.action === 'start') {
        const objective = typeof command.objective === 'string' ? command.objective.trim() : '';
        return objective ? `/goal ${objective}` : null;
    }
    return null;
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    const goalResult = parseGoal(message);
    if (goalResult.isGoal && goalResult.action) {
        return {
            type: 'goal',
            originalMessage: goalResult.originalMessage,
            goal: {
                action: goalResult.action,
                objective: goalResult.objective
            }
        };
    }

    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }
    
    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }
    
    return {
        type: null
    };
}
