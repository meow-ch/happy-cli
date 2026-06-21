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
