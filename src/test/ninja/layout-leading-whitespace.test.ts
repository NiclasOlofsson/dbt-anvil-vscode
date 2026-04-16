import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.leading-whitespace';

describe(RULE, () => {
	it('flags file starting with blank lines', () => {
		const v = violationsFor(run('\n\nselect 1\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('passes file starting with content', () => {
		const v = violationsFor(run('select 1\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags file starting with single blank line', () => {
		const v = violationsFor(run('\nselect 1\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('flags file starting with whitespace-only lines', () => {
		const v = violationsFor(run('   \n  \nselect 1\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('provides a delete fix removing leading blank lines', () => {
		const v = violationsFor(run('\n\nselect 1\n'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('');
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.end.line).toBe(2);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('handles file with only blank lines', () => {
		// All lines are blank — firstNonBlank === lines.length, no violation
		const v = violationsFor(run('\n\n\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags many leading blank lines', () => {
		const v = violationsFor(run('\n\n\n\n\nselect 1\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].range.end.line).toBe(5);
	});

	it('does not flag indented first line', () => {
		const v = violationsFor(run('    select 1\n'), RULE);
		expect(v.length).toBe(0);
	});
});
