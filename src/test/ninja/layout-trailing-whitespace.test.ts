import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.trailing-whitespace';

describe(RULE, () => {
	it('detects trailing spaces', () => {
		const v = violationsFor(run('select 1   \n'), RULE);
		expect(v.length).toBe(1);
	});

	it('detects trailing tabs', () => {
		const v = violationsFor(run('select 1\t\t\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('detects mixed trailing whitespace', () => {
		const v = violationsFor(run('select 1 \t \n'), RULE);
		expect(v.length).toBe(1);
	});

	it('passes clean lines', () => {
		const v = violationsFor(run('select 1\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags multiple lines with trailing whitespace', () => {
		const v = violationsFor(run('select 1  \nfrom t  \n'), RULE);
		expect(v.length).toBe(2);
	});

	it('provides a delete fix removing trailing whitespace', () => {
		const v = violationsFor(run('select 1   \n'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0].kind).toBe('delete');
		expect(v[0].range.start.character).toBe(8);
		expect(v[0].range.end.character).toBe(11);
	});

	it('ignores blank lines', () => {
		const v = violationsFor(run('select 1\n\nfrom t\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles CRLF line endings', () => {
		const v = violationsFor(run('select 1   \r\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('handles single trailing space', () => {
		const v = violationsFor(run('select 1 \n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].range.start.character).toBe(8);
		expect(v[0].range.end.character).toBe(9);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});
});
