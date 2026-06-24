import { describe, expect, it } from 'vitest';

import { resolveCodexExecutionPolicy } from './executionPolicy';

describe('resolveCodexExecutionPolicy permission presets', () => {
    it('maps ask to workspace access with untrusted approval', () => {
        expect(resolveCodexExecutionPolicy({ permissionPreset: 'ask' })).toMatchObject({
            permissionProfile: ':workspace',
            approvalPolicy: 'untrusted',
            permissionPreset: 'ask',
        });
    });

    it('maps auto_edits to workspace access with explicit approval requests', () => {
        expect(resolveCodexExecutionPolicy({ permissionPreset: 'auto_edits' })).toMatchObject({
            permissionProfile: ':workspace',
            approvalPolicy: 'on-request',
            permissionPreset: 'auto_edits',
        });
    });

    it('maps read_only and full_access to native Codex permission profiles', () => {
        expect(resolveCodexExecutionPolicy({ permissionPreset: 'read_only' })).toMatchObject({
            permissionProfile: ':read-only',
            approvalPolicy: 'never',
        });
        expect(resolveCodexExecutionPolicy({ permissionPreset: 'full_access' })).toMatchObject({
            permissionProfile: ':danger-full-access',
            approvalPolicy: 'never',
        });
    });

    it('lets provider-native overrides win over preset defaults', () => {
        expect(resolveCodexExecutionPolicy({
            permissionPreset: 'read_only',
            accessMode: 'workspace-write',
            approvalPolicy: 'on-request',
        })).toMatchObject({
            permissionProfile: ':workspace',
            approvalPolicy: 'on-request',
        });
    });
});
