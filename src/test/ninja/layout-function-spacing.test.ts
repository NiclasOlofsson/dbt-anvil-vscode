import { describe, it, expect } from 'vitest';
import { run, violationsFor, model } from './helpers';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/sql-tokens';
// Real sqlTokens from test fixtures. Regenerate with:
//   npx vitest run src/test/ninja/dump-layout-tokens.test.ts
import FIXTURES from './fixtures/layout-function-spacing-tokens.json';

function tokensFor(key: keyof typeof FIXTURES): SqlToken[] {
	return FIXTURES[key].sqlTokens as SqlToken[];
}

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
		expect((v[0].action as FixAction).ops[0].kind).toBe('delete');
	});

	it('flags multiple spaces before paren', () => {
		const v = violationsFor(run('select count   (*) from t\n'), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).ops[0].kind).toBe('delete');
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

	it('does not flag function name inside a -- line comment', () => {
		// Real-parser fixture: sqlTokens carry comment spans attached to tokens.
		// The rule must mask the word "count" inside the -- comment.
		const sql = FIXTURES.comment_with_count.sql;
		const m = model({ sqlTokens: tokensFor('comment_with_count') });
		const v = violationsFor(run(sql, {}, m), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag function name inside a /* */ block comment', () => {
		const sql = FIXTURES.block_comment.sql;
		const m = model({ sqlTokens: tokensFor('block_comment') });
		const v = violationsFor(run(sql, {}, m), RULE);
		expect(v.length).toBe(0);
	});

	it('still flags real function spacing errors on lines that also have a comment', () => {
		// count (*) before the -- is a real violation; "count" in the comment is not
		const sql = FIXTURES.violation_plus_comment.sql;
		const m = model({ sqlTokens: tokensFor('violation_plus_comment') });
		const v = violationsFor(run(sql, {}, m), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('count');
	});

	it('does not flag function inside a -- comment preceded by a string literal containing --', () => {
		// '-- not a comment' is inside a string, so avg (x) is real SQL.
		// The -- comment at the end contains count (x) which must not be flagged.
		const sql = FIXTURES.string_with_comment.sql;
		const m = model({ sqlTokens: tokensFor('string_with_comment') });
		const v = violationsFor(run(sql, {}, m), RULE);
		expect(v.length).toBe(1); // only avg (x) is a real violation
		expect(v[0].message).toContain('avg');
	});

	it('does not flag function without parenthesis at all', () => {
		const v = violationsFor(run('select count from t\n'), RULE);
		expect(v.length).toBe(0);
	});
});
