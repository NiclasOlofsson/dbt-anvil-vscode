import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, applyEditsToText } from './helpers';
import { indentCommentsRule } from '../../ninja/rules/layout-indent-comments';
import { FixAction } from '../../ninja/violation';

function check(sql: string) {
	const doc = mockDocument(sql);
	const lines = sql.split('\n');
	return indentCommentsRule.check({
		text: sql,
		lines,
		jinjaTokens: [],
		document: doc,
		config: cfg(),
	});
}

describe('ninja.layout.indent-comments', () => {
	it('no violation when comment matches next line indent', () => {
		const sql = 'select\n    -- explain the next column\n    a\nfrom t';
		expect(check(sql)).toHaveLength(0);
	});

	it('no violation at column 0 (section header escape hatch)', () => {
		const sql = 'select\n-- ========== SECTION ==========\n    a\nfrom t';
		expect(check(sql)).toHaveLength(0);
	});

	it('flags comment indented less than next code line', () => {
		// Comment at 2 spaces, next code line at 4 spaces
		const sql = 'select\n  -- wrong indent\n    a\nfrom t';
		const v = check(sql);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe('ninja.layout.indent-comments');
		expect(v[0].message).toContain('column 4');
		expect(v[0].message).toContain('column 2');
	});

	it('flags comment over-indented relative to next code line', () => {
		const sql = 'select\n        -- over-indented\n    a\nfrom t';
		const v = check(sql);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('column 4');
		expect(v[0].message).toContain('column 8');
	});

	it('autofix replaces leading whitespace to match next code line', () => {
		const sql = 'select\n  -- wrong indent\n    a\nfrom t';
		const v = check(sql);
		expect(v).toHaveLength(1);
		const ops = (v[0].action as FixAction).ops;
		const fixed = applyEditsToText(sql, ops);
		const fixedLine = fixed.split('\n')[1];
		expect(fixedLine).toBe('    -- wrong indent');
	});

	it('skips blank lines between comment and next code line', () => {
		const sql = 'select\n    -- comment\n\n\n    a\nfrom t';
		expect(check(sql)).toHaveLength(0);
	});

	it('groups consecutive comments using the code line below the last one', () => {
		// Both comments should match the indent of 'a' (4 spaces)
		const sql = 'select\n    -- first comment\n    -- second comment\n    a\nfrom t';
		expect(check(sql)).toHaveLength(0);
	});

	it('flags consecutive comments when none match next code line', () => {
		const sql = 'select\n  -- first\n  -- second\n    a\nfrom t';
		const v = check(sql);
		expect(v).toHaveLength(2);
	});

	it('falls back to previous code line for end-of-file comments', () => {
		const sql = 'select\n    a\nfrom t\n  -- trailing comment at end';
		const v = check(sql);
		expect(v).toHaveLength(1);
		// Previous code line 'from t' has 0 indent → expected col 0 but comment has 2
		expect(v[0].message).toContain('column 0');
	});

	it('does not flag trailing comments on code lines', () => {
		// Trailing comments (after code on same line) start with something else
		// before the --. Our rule only checks lines where -- is first content.
		const sql = 'select a -- trailing comment\nfrom t';
		expect(check(sql)).toHaveLength(0);
	});

	it('no violations on empty document', () => {
		expect(check('')).toHaveLength(0);
	});

	it('no violations when there is no following code', () => {
		// No code at all → nothing to match against, fallback also empty
		const sql = '    -- just a comment';
		expect(check(sql)).toHaveLength(0);
	});
});
