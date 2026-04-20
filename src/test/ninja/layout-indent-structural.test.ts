import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { indentOnRule } from '../../ninja/rules/layout-indent-on';
import { indentJoinsRule } from '../../ninja/rules/layout-indent-joins';
import { indentThenRule } from '../../ninja/rules/layout-indent-then';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';
import { DEFAULT_CONFIG } from '../../ninja/config';

// ── helpers ────────────────────────────────────────────────────────────────

function indentCfg(overrides: Partial<typeof DEFAULT_CONFIG.indentation> = {}) {
	return cfg({ indentation: { ...DEFAULT_CONFIG.indentation, ...overrides } });
}

function checkOn(sql: string, tokens: SqlToken[], indentedOn: boolean) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return indentOnRule.check({ model: m, document: doc, config: indentCfg({ indentedOn }) });
}

function checkJoins(sql: string, tokens: SqlToken[], indentedJoins: boolean) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return indentJoinsRule.check({ model: m, document: doc, config: indentCfg({ indentedJoins }) });
}

function checkThen(sql: string, tokens: SqlToken[], indentedThen: boolean) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return indentThenRule.check({ model: m, document: doc, config: indentCfg({ indentedThen }) });
}

// sqlTok(type, start, end, line, col)
// col = 1-based exclusive end col (sqlglot convention)

// ── indent-on ──────────────────────────────────────────────────────────────

describe('ninja.layout.indent-on', () => {
	// from
	//     base_table
	// left join other_table
	// on condition          ← on at col 0, should be col 4 (indentedOn=true)
	it('flags ON at col 0 when indentedOn=true', () => {
		const sql = 'from\n    base_table\nleft join other\non condition';
		//           0123    456789...     1111111111  222222222222
		// line 0: from (0-3), col=4
		// line 1: base_table (5-14), col=15 → wait let me count manually
		// Actually I'll just compute the offsets:
		// 'from\n'             = 0-4  (5 chars)
		// '    base_table\n'   = 5-19 (15 chars)
		// 'left join other\n'  = 20-35 (16 chars)
		// 'on condition'       = 36-47
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   9, 18, 1, 14),   // base_table at line 1, col 5-14, col=15
			sqlTok('LEFT', 20, 23, 2, 4),    // left at col 0
			sqlTok('JOIN', 25, 28, 2, 9),    // join at col 5
			sqlTok('VAR',  30, 34, 2, 15),   // other at col 10
			sqlTok('ON',   36, 37, 3, 2),    // on at col 0
			sqlTok('VAR',  39, 47, 3, 12),   // condition
		];
		const v = checkOn(sql, toks, true);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe('ninja.layout.indent-on');
		expect(v[0].message).toContain('column 4');
		expect(v[0].message).toContain('column 0');
	});

	it('no violation when ON is already at correct indent (indentedOn=true)', () => {
		// left join other
		//     on condition    ← 4 spaces
		const sql = 'from base\nleft join other\n    on condition';
		// line 0: from=0-3 col=4, base=5-8 col=9
		// line 1: left=10-13 col=4, join=15-18 col=9, other=20-24 col=15
		// line 2: on=29-30 col=6  (4 spaces before on → start col=4, col=6 meaning exclusive end=6)
		// Wait: '    on' → 4 spaces + 'on' = 6 chars → start=4, end=5, col=6
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   30, 31, 2, 6),   // start col = 6 - 2 = 4 ✓
			sqlTok('VAR',  33, 41, 2, 15),
		];
		const v = checkOn(sql, toks, true);
		expect(v).toHaveLength(0);
	});

	it('no violation when ON is on same line as JOIN (inline)', () => {
		const sql = 'from base\nleft join other on condition';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   26, 27, 1, 18),  // same line as JOIN
			sqlTok('VAR',  29, 37, 1, 29),
		];
		const v = checkOn(sql, toks, true);
		expect(v).toHaveLength(0);
	});

	it('no violation when indentedOn=false and ON is at JOIN level (col 0)', () => {
		const sql = 'from base\nleft join other\non condition';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   26, 27, 2, 2),   // col 0
			sqlTok('VAR',  29, 37, 2, 12),
		];
		const v = checkOn(sql, toks, false);
		expect(v).toHaveLength(0);
	});

	it('flags ON when indentedOn=false but ON is indented', () => {
		// ON at col 4 is wrong when indentedOn=false and join is at col 0
		const sql = 'from base\nleft join other\n    on condition';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   30, 31, 2, 6),   // start col = 4
			sqlTok('VAR',  33, 41, 2, 15),
		];
		const v = checkOn(sql, toks, false);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('column 0');
	});

	it('autofix replaces leading whitespace with correct indent', () => {
		const sql = 'from base\nleft join other\non condition';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   26, 27, 2, 2),
			sqlTok('VAR',  29, 37, 2, 12),
		];
		const v = checkOn(sql, toks, true);
		expect(v).toHaveLength(1);
		const ops = (v[0].action as FixAction).ops;
		const fixed = applyEditsToText(sql, ops);
		expect(fixed).toContain('    on');
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('from t\nleft join s\non x = y');
		const m = model({});
		expect(indentOnRule.check({ model: m, document: doc, config: indentCfg({ indentedOn: true }) })).toHaveLength(0);
	});
});

// ── indent-joins ──────────────────────────────────────────────────────────

describe('ninja.layout.indent-joins', () => {
	it('no violation when JOIN is at same level as FROM (indentedJoins=false)', () => {
		// from base
		// join other on ...
		const sql = 'from base\njoin other\non cond';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('JOIN', 10, 13, 1, 4),  // col 0
			sqlTok('VAR',  15, 19, 1, 10),
			sqlTok('ON',   21, 22, 2, 2),
			sqlTok('VAR',  24, 27, 2, 7),
		];
		const v = checkJoins(sql, toks, false);
		expect(v).toHaveLength(0);
	});

	it('flags JOIN indented when indentedJoins=false', () => {
		// from base
		//     join other    ← 4-space indent is wrong when indentedJoins=false
		const sql = 'from base\n    join other\non cond';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('JOIN', 14, 17, 1, 8),  // start col = 8-4=4
			sqlTok('VAR',  19, 23, 1, 14),
			sqlTok('ON',   25, 26, 2, 2),
			sqlTok('VAR',  28, 31, 2, 7),
		];
		const v = checkJoins(sql, toks, false);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('column 0');
	});

	it('no violation when LEFT JOIN anchor is at same level as FROM (indentedJoins=false)', () => {
		const sql = 'from base\nleft join other\non cond';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),  // col 0
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   26, 27, 2, 2),
			sqlTok('VAR',  29, 33, 2, 7),
		];
		const v = checkJoins(sql, toks, false);
		expect(v).toHaveLength(0);
	});

	it('flags LEFT JOIN anchor when indentedJoins=true and not indented', () => {
		const sql = 'from base\nleft join other\non cond';
		const toks: SqlToken[] = [
			sqlTok('FROM',  0,  3, 0, 4),
			sqlTok('VAR',   5,  8, 0, 9),
			sqlTok('LEFT', 10, 13, 1, 4),  // col 0 — should be col 4
			sqlTok('JOIN', 15, 18, 1, 9),
			sqlTok('VAR',  20, 24, 1, 15),
			sqlTok('ON',   26, 27, 2, 2),
			sqlTok('VAR',  29, 33, 2, 7),
		];
		const v = checkJoins(sql, toks, true);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('column 4');
	});

	it('does not trigger on JOIN on same line as FROM', () => {
		const sql = 'from base join other on cond';
		const toks: SqlToken[] = [
			sqlTok('FROM', 0, 3, 0, 4),
			sqlTok('VAR',  5, 8, 0, 9),
			sqlTok('JOIN', 10, 13, 0, 14),  // same line as FROM
			sqlTok('VAR',  15, 19, 0, 20),
			sqlTok('ON',   21, 22, 0, 23),
			sqlTok('VAR',  24, 27, 0, 28),
		];
		const v = checkJoins(sql, toks, false);
		expect(v).toHaveLength(0);
	});
});

// ── indent-then ────────────────────────────────────────────────────────────

describe('ninja.layout.indent-then', () => {
	it('flags THEN at WHEN level when indentedThen=true', () => {
		// case
		//     when x
		// then 1     ← col 0, should be col 8 (when is at col 4, then = when+4)
		const sql = 'case\n    when x\nthen 1\nend';
		// line 0: case=0-3 col=4
		// line 1: when=9-12 col=5 (start=4), x=14 col=15
		// line 2: then=16-19 col=4 (start=0)
		// line 3: end=21-23 col=4
		const toks: SqlToken[] = [
			sqlTok('CASE', 0,  3, 0, 4),
			sqlTok('WHEN', 9, 12, 1, 8),   // start col = 8-4=4
			sqlTok('VAR', 14, 14, 1, 15),
			sqlTok('THEN', 16, 19, 2, 4),  // start col = 4-4=0
			sqlTok('NUMBER', 21, 21, 2, 6),
			sqlTok('END', 23, 25, 3, 3),
		];
		const v = checkThen(sql, toks, true);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe('ninja.layout.indent-then');
		expect(v[0].message).toContain('column 8');
		expect(v[0].message).toContain('column 0');
	});

	it('no violation when THEN is already correctly indented (indentedThen=true)', () => {
		// case
		//     when x
		//         then 1    ← 8 spaces
		const sql = 'case\n    when x\n        then 1\nend';
		const toks: SqlToken[] = [
			sqlTok('CASE', 0,  3, 0, 4),
			sqlTok('WHEN', 9, 12, 1, 8),    // start col = 4
			sqlTok('VAR', 14, 14, 1, 15),
			sqlTok('THEN', 24, 27, 2, 12),  // start col = 12-4=8 ✓
			sqlTok('NUMBER', 29, 29, 2, 14),
			sqlTok('END', 31, 33, 3, 3),
		];
		const v = checkThen(sql, toks, true);
		expect(v).toHaveLength(0);
	});

	it('no violation when THEN is on same line as WHEN', () => {
		const sql = 'case\n    when x then 1\nend';
		const toks: SqlToken[] = [
			sqlTok('CASE', 0,  3, 0, 4),
			sqlTok('WHEN', 9, 12, 1, 8),
			sqlTok('VAR', 14, 14, 1, 15),
			sqlTok('THEN', 16, 19, 1, 20),  // same line as WHEN
			sqlTok('NUMBER', 21, 21, 1, 22),
			sqlTok('END', 23, 25, 2, 3),
		];
		const v = checkThen(sql, toks, true);
		expect(v).toHaveLength(0);
	});

	it('no violation when indentedThen=false and THEN at WHEN level', () => {
		// case
		//     when x
		//     then 1     ← col 4, same as when — correct when indentedThen=false
		const sql = 'case\n    when x\n    then 1\nend';
		const toks: SqlToken[] = [
			sqlTok('CASE', 0,  3, 0, 4),
			sqlTok('WHEN', 9, 12, 1, 8),   // start col = 4
			sqlTok('VAR', 14, 14, 1, 15),
			sqlTok('THEN', 20, 23, 2, 8),  // start col = 8-4=4 ✓ same as WHEN
			sqlTok('NUMBER', 25, 25, 2, 10),
			sqlTok('END', 27, 29, 3, 3),
		];
		const v = checkThen(sql, toks, false);
		expect(v).toHaveLength(0);
	});

	it('autofix inserts correct indent before THEN', () => {
		const sql = 'case\n    when x\nthen 1\nend';
		const toks: SqlToken[] = [
			sqlTok('CASE', 0,  3, 0, 4),
			sqlTok('WHEN', 9, 12, 1, 8),
			sqlTok('VAR', 14, 14, 1, 15),
			sqlTok('THEN', 16, 19, 2, 4),  // col 0
			sqlTok('NUMBER', 21, 21, 2, 6),
			sqlTok('END', 23, 25, 3, 3),
		];
		const v = checkThen(sql, toks, true);
		expect(v).toHaveLength(1);
		const ops = (v[0].action as FixAction).ops;
		const fixed = applyEditsToText(sql, ops);
		expect(fixed).toContain('        then');
	});
});
