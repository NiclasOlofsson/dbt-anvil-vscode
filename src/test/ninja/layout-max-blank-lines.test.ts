import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';

const RULE = 'ninja.layout.max-blank-lines';

describe(RULE, () => {
	it('flags consecutive blank lines', () => {
		const v = violationsFor(run('select 1\n\n\n\nfrom t\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('allows one or two blank lines', () => {
		const v1 = violationsFor(run('select 1\n\nfrom t\n'), RULE);
		expect(v1.length).toBe(0);
		const v2 = violationsFor(run('select 1\n\n\nfrom t\n'), RULE);
		expect(v2.length).toBe(0);
	});

	it('flags three consecutive blank lines', () => {
		const v = violationsFor(run('select 1\n\n\n\nfrom t\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('3');
	});

	it('flags multiple groups of consecutive blank lines', () => {
		const v = violationsFor(run('select 1\n\n\n\nfrom t\n\n\n\nwhere x = 1\n'), RULE);
		expect(v.length).toBe(2);
	});

	it('provides delete fix for extra blank lines', () => {
		const v = violationsFor(run('select 1\n\n\n\nfrom t\n'), RULE);
		expect(v[0].fix).toBeDefined();
		expect(v[0].fix![0].newText).toBe('');
	});

	it('passes file with no blank lines', () => {
		const v = violationsFor(run('select 1\nfrom t\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles trailing consecutive blank lines — owned by trailing-newline rule', () => {
		const v = violationsFor(run('select 1\n\n\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('handles CRLF blank lines', () => {
		const v = violationsFor(run('select 1\r\n\r\n\r\nfrom t\r\n'), RULE);
		expect(v.length).toBe(0); // 2 blank lines = within max
		const v2 = violationsFor(run('select 1\r\n\r\n\r\n\r\nfrom t\r\n'), RULE);
		expect(v2.length).toBe(1); // 3 blank lines = over max
	});
});
