import { describe, it, expect } from 'vitest';
import { mapToClaudeMode } from './permissionMode';
import type { PermissionMode } from '@/api/types';

describe('mapToClaudeMode', () => {
    describe('Codex modes are mapped to Claude equivalents', () => {
        it('maps yolo → bypassPermissions', () => {
            expect(mapToClaudeMode('yolo')).toBe('bypassPermissions');
        });

        it('maps safe-yolo → default', () => {
            expect(mapToClaudeMode('safe-yolo')).toBe('default');
        });

        it('maps read-only → default', () => {
            expect(mapToClaudeMode('read-only')).toBe('default');
        });
    });

    describe('Claude modes pass through unchanged', () => {
        it('passes through default', () => {
            expect(mapToClaudeMode('default')).toBe('default');
        });

        it('passes through acceptEdits', () => {
            expect(mapToClaudeMode('acceptEdits')).toBe('acceptEdits');
        });

        it('passes through auto', () => {
            expect(mapToClaudeMode('auto')).toBe('auto');
        });

        it('passes through bypassPermissions', () => {
            expect(mapToClaudeMode('bypassPermissions')).toBe('bypassPermissions');
        });

        it('passes through dontAsk', () => {
            expect(mapToClaudeMode('dontAsk')).toBe('dontAsk');
        });

        it('passes through plan', () => {
            expect(mapToClaudeMode('plan')).toBe('plan');
        });
    });

    describe('all PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan',  // Claude modes
            'read-only', 'safe-yolo', 'yolo'  // Codex modes
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });
    });
});
