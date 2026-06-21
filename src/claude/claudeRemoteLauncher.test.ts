import { describe, expect, it } from 'vitest';

import { __testClaudeRemoteLauncherInternals } from './claudeRemoteLauncher';

describe('Claude plan extraction', () => {
    it('extracts plan text from native ExitPlanMode tool input shapes', () => {
        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText({
            plan: 'Read the code, then patch it.',
        })).toBe('Read the code, then patch it.');

        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText([
            { text: 'First step.' },
            { message: 'Second step.' },
        ])).toBe('First step.\n\nSecond step.');

        expect(__testClaudeRemoteLauncherInternals.extractClaudePlanText({
            actions: ['fallback'],
        })).toBe('{\n  "actions": [\n    "fallback"\n  ]\n}');
    });
});
