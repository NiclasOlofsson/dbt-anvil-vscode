import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.function_spacing';

describe(RULE, () => {
	it('flags space before opening parenthesis', () => {
		const v = violationsFor(run('select count (*) from t\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('count');
	});

	it('passes function with no space', () => {
		const v = violationsFor(run('select count(*) from t\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('provides a delete fix removing the space', () => {
		const v = violationsFor(run('select count (*) from t\n'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('');
	});

	it('flags multiple spaces before paren', () => {
		const v = violationsFor(run('select count   (*) from t\n'), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('');
	});

	it('flags tab before paren', () => {
		const v = violationsFor(run('select count\t(*) from t\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('flags multiple functions with spacing issues', () => {
		const v = violationsFor(run('select count (*), sum (x) from t\n'), RULE);
		expect(v.length).toBe(2);
	});

	it('does not flag non-function words followed by paren', () => {
		// 'select' is not in SQL_FUNCTIONS set (it's a keyword)
		const v = violationsFor(run('select (1)\n'), RULE);
		expect(v.length).toBe(0);
	});

	it('fix range covers only the space between function and paren', () => {
		const v = violationsFor(run('select count (*) from t\n'), RULE);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(12); // after 'count'
		expect(v[0].range.end.character).toBe(13); // before '('
	});

	it('handles nested functions with spacing', () => {
		const v = violationsFor(run('select coalesce (count (*), 0) from t\n'), RULE);
		expect(v.length).toBe(2);
	});

	it('handles multi-word function names', () => {
		const v = violationsFor(run('select date_trunc (\'day\', x) from t\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag function without parenthesis at all', () => {
		const v = violationsFor(run('select count from t\n'), RULE);
		expect(v.length).toBe(0);
	});
});
