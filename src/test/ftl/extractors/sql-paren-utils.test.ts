import { describe, expect, it } from 'vitest';
import {
	findCteDef,
	findMatchingParen,
	isPositionInComment,
} from '../../../ftl/extractors/sql-paren-utils';

describe('isPositionInComment', () => {
	it('returns false for plain SQL positions', () => {
		const sql = 'SELECT a FROM t';
		expect(isPositionInComment(sql, 0)).toBe(false);
		expect(isPositionInComment(sql, sql.length - 1)).toBe(false);
	});

	it('detects positions inside `--` line comments', () => {
		const sql = 'SELECT a -- this is x\nFROM t';
		const idx = sql.indexOf('this');
		expect(isPositionInComment(sql, idx)).toBe(true);
	});

	it('does NOT mark `--` as commenting subsequent lines', () => {
		const sql = 'SELECT a -- comment\nFROM t';
		const idx = sql.indexOf('FROM');
		expect(isPositionInComment(sql, idx)).toBe(false);
	});

	it('detects positions inside `/* */` block comments', () => {
		const sql = 'SELECT /* hidden */ a';
		const idx = sql.indexOf('hidden');
		expect(isPositionInComment(sql, idx)).toBe(true);
	});

	it('detects positions inside `{# #}` jinja comments', () => {
		const sql = 'SELECT {# secret #} 1';
		const idx = sql.indexOf('secret');
		expect(isPositionInComment(sql, idx)).toBe(true);
	});

	it('returns false after a block comment closes', () => {
		const sql = '/* x */ SELECT 1';
		const idx = sql.indexOf('SELECT');
		expect(isPositionInComment(sql, idx)).toBe(false);
	});
});

describe('findMatchingParen', () => {
	it('finds the matching paren for a simple expression', () => {
		const sql = 'SELECT (1 + 2) FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		expect(sql.slice(open, after)).toBe('(1 + 2)');
	});

	it('handles nested parens', () => {
		const sql = 'SELECT ((a + b) * (c - d)) FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		expect(sql.slice(open, after)).toBe('((a + b) * (c - d))');
	});

	it('skips parens inside single-quoted strings', () => {
		const sql = 'SELECT regex_match(col, \'(foo)\') FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		expect(sql.slice(open, after)).toBe('(col, \'(foo)\')');
	});

	it('skips parens inside double-quoted identifiers', () => {
		const sql = 'SELECT f("col(name)") FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		expect(sql.slice(open, after)).toBe('("col(name)")');
	});

	it('skips parens inside `--` line comments', () => {
		const sql = 'SELECT (a -- ignore (this)\n) FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		// Closing paren is the one on the next line, not the `(this)` inside the comment.
		expect(sql.slice(open, after)).toBe('(a -- ignore (this)\n)');
	});

	it('skips parens inside `/* */` block comments', () => {
		const sql = 'SELECT (a /* (nope) */ ) FROM t';
		const open = sql.indexOf('(');
		const after = findMatchingParen(sql, open);
		expect(sql.slice(open, after)).toBe('(a /* (nope) */ )');
	});

	it('returns -1 for an unclosed paren', () => {
		const sql = 'SELECT (1 + 2 FROM t';
		const open = sql.indexOf('(');
		expect(findMatchingParen(sql, open)).toBe(-1);
	});
});

describe('findCteDef', () => {
	it('locates a simple `name AS (` definition', () => {
		const sql = 'WITH orders AS (SELECT 1) SELECT * FROM orders';
		const def = findCteDef(sql, 'orders');
		expect(def).not.toBeNull();
		expect(def!.matchStart).toBe(sql.indexOf('orders'));
		expect(sql[def!.parenPos]).toBe('(');
	});

	it('locates a Spark/Databricks-style CTE without `AS`', () => {
		const sql = 'WITH agg (SELECT 1) SELECT * FROM agg';
		const def = findCteDef(sql, 'agg');
		expect(def).not.toBeNull();
		expect(sql[def!.parenPos]).toBe('(');
	});

	it('skips matches inside comments and finds the real definition', () => {
		const sql = '-- orders AS (fake)\nWITH orders AS (SELECT 1) SELECT * FROM orders';
		const def = findCteDef(sql, 'orders');
		expect(def).not.toBeNull();
		// The real one is on line 2, after the comment.
		expect(def!.matchStart).toBeGreaterThan(sql.indexOf('\n'));
	});

	it('matches case-insensitively', () => {
		const sql = 'with ORDERS as (select 1) select * from orders';
		const def = findCteDef(sql, 'orders');
		expect(def).not.toBeNull();
		expect(sql[def!.parenPos]).toBe('(');
	});

	it('returns null when no CTE definition exists', () => {
		const sql = 'SELECT * FROM orders';
		expect(findCteDef(sql, 'orders')).toBeNull();
	});

	it('finds end position via findMatchingParen for a multi-line CTE body', () => {
		const sql = 'WITH a AS (\n  SELECT id\n  FROM raw\n)\nSELECT * FROM a';
		const def = findCteDef(sql, 'a');
		const endAfter = findMatchingParen(sql, def!.parenPos);
		const body = sql.slice(def!.parenPos, endAfter);
		expect(body.startsWith('(')).toBe(true);
		expect(body.endsWith(')')).toBe(true);
		expect(body).toContain('FROM raw');
	});

	it('handles a CTE body containing strings and comments', () => {
		const sql = 'WITH x AS (SELECT \'(weird)\' /* not ) the end */ ) SELECT * FROM x';
		const def = findCteDef(sql, 'x');
		const endAfter = findMatchingParen(sql, def!.parenPos);
		const body = sql.slice(def!.parenPos, endAfter);
		expect(body.endsWith(')')).toBe(true);
		expect(body).toContain('(weird)');
	});
});
