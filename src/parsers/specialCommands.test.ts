import { describe, it, expect } from 'vitest';
import { formatGoalCommand, parseCompact, parseClear, parseGoal, parseSpecialCommand } from './specialCommands';

describe('parseCompact', () => {
    it('should parse /compact command with argument', () => {
        const result = parseCompact('/compact optimize the code');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact optimize the code');
    });

    it('should parse /compact command without argument', () => {
        const result = parseCompact('/compact');
        expect(result.isCompact).toBe(true);
        expect(result.originalMessage).toBe('/compact');
    });

    it('should not parse regular messages', () => {
        const result = parseCompact('hello world');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('hello world');
    });

    it('should not parse messages that contain compact but do not start with /compact', () => {
        const result = parseCompact('please /compact this');
        expect(result.isCompact).toBe(false);
        expect(result.originalMessage).toBe('please /compact this');
    });
});

describe('parseClear', () => {
    it('should parse /clear command exactly', () => {
        const result = parseClear('/clear');
        expect(result.isClear).toBe(true);
    });

    it('should parse /clear command with whitespace', () => {
        const result = parseClear('  /clear  ');
        expect(result.isClear).toBe(true);
    });

    it('should not parse /clear with arguments', () => {
        const result = parseClear('/clear something');
        expect(result.isClear).toBe(false);
    });

    it('should not parse regular messages', () => {
        const result = parseClear('hello world');
        expect(result.isClear).toBe(false);
    });
});

describe('parseGoal', () => {
    it('should parse /goal objective as start', () => {
        const result = parseGoal('/goal Finish the migration and keep tests green');
        expect(result.isGoal).toBe(true);
        expect(result.action).toBe('start');
        expect(result.objective).toBe('Finish the migration and keep tests green');
        expect(result.originalMessage).toBe('/goal Finish the migration and keep tests green');
    });

    it('should parse /goal lifecycle commands', () => {
        expect(parseGoal('/goal').action).toBe('view');
        expect(parseGoal('/goal pause').action).toBe('pause');
        expect(parseGoal('/goal resume').action).toBe('resume');
        expect(parseGoal('/goal clear').action).toBe('clear');
    });

    it('should not parse embedded or partial goal text', () => {
        expect(parseGoal('please /goal this').isGoal).toBe(false);
        expect(parseGoal('/goals test').isGoal).toBe(false);
    });
});

describe('formatGoalCommand', () => {
    it('should format structured goal commands', () => {
        expect(formatGoalCommand({ action: 'view' })).toBe('/goal');
        expect(formatGoalCommand({ action: 'pause' })).toBe('/goal pause');
        expect(formatGoalCommand({ action: 'resume' })).toBe('/goal resume');
        expect(formatGoalCommand({ action: 'clear' })).toBe('/goal clear');
        expect(formatGoalCommand({ action: 'start', objective: 'Ship it' })).toBe('/goal Ship it');
    });

    it('should reject invalid structured goal commands', () => {
        expect(formatGoalCommand({ action: 'start', objective: '   ' })).toBeNull();
        expect(formatGoalCommand({ action: 'unknown' })).toBeNull();
        expect(formatGoalCommand(null)).toBeNull();
    });
});

describe('parseSpecialCommand', () => {
    it('should detect goal command', () => {
        const result = parseSpecialCommand('/goal Finish the migration');
        expect(result.type).toBe('goal');
        expect(result.originalMessage).toBe('/goal Finish the migration');
        expect(result.goal).toEqual({
            action: 'start',
            objective: 'Finish the migration'
        });
    });

    it('should detect compact command', () => {
        const result = parseSpecialCommand('/compact optimize');
        expect(result.type).toBe('compact');
        expect(result.originalMessage).toBe('/compact optimize');
    });

    it('should detect clear command', () => {
        const result = parseSpecialCommand('/clear');
        expect(result.type).toBe('clear');
        expect(result.originalMessage).toBeUndefined();
    });

    it('should return null for regular messages', () => {
        const result = parseSpecialCommand('hello world');
        expect(result.type).toBeNull();
        expect(result.originalMessage).toBeUndefined();
    });

    it('should handle edge cases correctly', () => {
        // Test with extra whitespace
        expect(parseSpecialCommand('  /goal test  ').type).toBe('goal');
        expect(parseSpecialCommand('  /compact test  ').type).toBe('compact');
        expect(parseSpecialCommand('  /clear  ').type).toBe('clear');
        
        // Test partial matches should not trigger
        expect(parseSpecialCommand('some /goal text').type).toBeNull();
        expect(parseSpecialCommand('/goals').type).toBeNull();
        expect(parseSpecialCommand('some /compact text').type).toBeNull();
        expect(parseSpecialCommand('/compactor').type).toBeNull();
        expect(parseSpecialCommand('/clearing').type).toBeNull();
    });
});
