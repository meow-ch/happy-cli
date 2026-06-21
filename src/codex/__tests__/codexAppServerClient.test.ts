import { describe, expect, it } from 'vitest';

import { __testCodexAppServerClientInternals } from '../codexAppServerClient';

describe('Codex app-server plan normalization', () => {
    it('normalizes plan steps and builds display text from native plan parts', () => {
        const steps = __testCodexAppServerClientInternals.normalizePlanSteps([
            { step: 'Inspect the code', status: 'complete' },
            { step: 'Patch the UI', status: 'pending' },
            { step: '' },
            null,
        ]);

        expect(steps).toEqual([
            { step: 'Inspect the code', status: 'complete' },
            { step: 'Patch the UI', status: 'pending' },
        ]);
        expect(__testCodexAppServerClientInternals.planTextFromParts('Need two actions.', steps))
            .toBe('Need two actions.\n\n- Inspect the code\n- Patch the UI');
    });
});

describe('Codex app-server turn lifecycle normalization', () => {
    it('maps native turn completions to provider-neutral task lifecycle events', () => {
        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { id: 'turn_complete_1', status: 'completed' },
        })).toEqual({ type: 'task_complete', turn_id: 'turn_complete_1' });

        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { id: 'turn_abort_1', status: 'interrupted' },
        })).toEqual({ type: 'turn_aborted', turn_id: 'turn_abort_1' });

        expect(__testCodexAppServerClientInternals.turnLifecycleEventFromCompletion({
            turn: { status: 'completed' },
        })).toEqual({ type: 'task_complete' });
    });
});
