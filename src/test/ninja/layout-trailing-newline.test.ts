import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.trailing-newline';

describe(RULE, () => {
	it('flags file not ending with newline', () => {
		const v = violationsFor(run('select 1'), RULE);
		expect(v.length).toBe(1);
	});

	it('passes file ending with single newline', () => {
		const v = violationsFor(run('select 1\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags file ending with multiple newlines', () => {
		const v = violationsFor(run('select 1\n\n\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('exactly one');
	});

	it('provides insert fix for missing newline', () => {
		const v = violationsFor(run('select 1'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0].text).toBe('\n');
	});

	it('provides replace fix for extra trailing newlines', () => {
		const v = violationsFor(run('select 1\n\n\n'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0].text).toBe('\n');
	});

	it('flags whitespace-only trailing line', () => {
		const v = violationsFor(run('select 1\n   \n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('exactly one');
	});

	it('provides replace fix for whitespace-only trailing line', () => {
		const v = violationsFor(run('select 1\n   \n'), RULE);
		expect((v[0].action as FixAction).ops[0].text).toBe('\n');
	});

	it('flags multiple trailing blank lines including whitespace', () => {
		const v = violationsFor(run('select 1\n\n  \n'), RULE);
		expect(v.length).toBe(1);
	});

	it('handles file with only newlines', () => {
		const v = violationsFor(run('\n\n\n'), RULE);
		// Multiple trailing newlines
		expect(v.length).toBe(1);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		// Empty file — no trailing newline to check
		expect(v.length).toBe(0);
	});

	it('handles single newline file', () => {
		const v = violationsFor(run('\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles multi-line file ending correctly', () => {
		const v = violationsFor(run('select\n    1\nfrom t\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles multi-line file missing trailing newline', () => {
		const v = violationsFor(run('select\n    1\nfrom t'), RULE);
		expect(v.length).toBe(1);
	});
});
