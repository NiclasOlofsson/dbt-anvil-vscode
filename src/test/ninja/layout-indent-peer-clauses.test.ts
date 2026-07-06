import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { indentFromRule } from '../../ninja/rules/layout-indent-from';
import { indentWhereRule } from '../../ninja/rules/layout-indent-where';
import { indentGroupByRule } from '../../ninja/rules/layout-indent-group-by';
import { indentHavingRule } from '../../ninja/rules/layout-indent-having';
import { indentOrderByRule } from '../../ninja/rules/layout-indent-order-by';
import { indentLimitRule } from '../../ninja/rules/layout-indent-limit';
import { indentSetOpRule } from '../../ninja/rules/layout-indent-set-op';
import { FixAction } from '../../ninja/violation';
import type { TokenRule } from '../../ninja/rule';
import type { SqlToken } from '../../ftl/sql-tokens';

function runRule(rule: TokenRule, sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return rule.check({ model: m, document: doc, config: cfg() });
}

// ── FROM ──────────────────────────────────────────────────────────────────

describe('ninja.layout.indent-from', () => {
	it('no violation when FROM matches SELECT indent', () => {
		// select *
		// from t
		const sql = 'select *\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR',   7, 7, 0, 8),
			sqlTok('FROM',   9, 12, 1, 4),
			sqlTok('VAR',   14, 14, 1, 6),
		];
		expect(runRule(indentFromRule, sql, toks)).toHaveLength(0);
	});

	it('flags FROM indented past SELECT', () => {
		const sql = 'select *\n    from t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',   13, 16, 1, 8),   // start col 8-4=4
			sqlTok('VAR',    18, 18, 1, 10),
		];
		const v = runRule(indentFromRule, sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('column 0');
		expect(v[0].message).toContain('column 4');
	});

	it('does not trigger when SELECT is on the same line as FROM', () => {
		const sql = 'select * from t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('STAR',   7,  7, 0, 8),
			sqlTok('FROM',   9, 12, 0, 13),
			sqlTok('VAR',   14, 14, 0, 15),
		];
		expect(runRule(indentFromRule, sql, toks)).toHaveLength(0);
	});

	it('respects subquery scope: inner FROM aligns with inner SELECT', () => {
		// select * from (
		//     select *
		//     from t        ← 4 spaces, matches inner SELECT
		// ) as sub
		const sql = 'select * from (\n    select *\n    from t\n) as sub';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 0, 13),
			sqlTok('L_PAREN', 14, 14, 0, 15),
			sqlTok('SELECT',  20, 25, 1, 10),  // start col 10-6=4
			sqlTok('STAR',    27, 27, 1, 12),
			sqlTok('FROM',    33, 36, 2, 8),   // start col 8-4=4, matches inner SELECT
			sqlTok('VAR',     38, 38, 2, 10),
			sqlTok('R_PAREN', 40, 40, 3, 1),
			sqlTok('AS',      42, 43, 3, 4),
			sqlTok('VAR',     45, 47, 3, 8),
		];
		expect(runRule(indentFromRule, sql, toks)).toHaveLength(0);
	});

	it('autofix replaces leading whitespace', () => {
		const sql = 'select *\n    from t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',   13, 16, 1, 8),
			sqlTok('VAR',    18, 18, 1, 10),
		];
		const v = runRule(indentFromRule, sql, toks);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed.split('\n')[1]).toBe('from t');
	});
});

// ── WHERE ──────────────────────────────────────────────────────────────────

describe('ninja.layout.indent-where', () => {
	it('no violation when WHERE matches FROM indent', () => {
		const sql = 'select *\nfrom t\nwhere x = 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 1, 6),
			sqlTok('WHERE',  16, 20, 2, 5),
			sqlTok('VAR',    22, 22, 2, 7),
			sqlTok('EQ',     24, 24, 2, 9),
			sqlTok('NUMBER', 26, 26, 2, 11),
		];
		expect(runRule(indentWhereRule, sql, toks)).toHaveLength(0);
	});

	it('flags WHERE indented past FROM', () => {
		const sql = 'select *\nfrom t\n    where x = 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 1, 6),
			sqlTok('WHERE',  20, 24, 2, 9),   // start col 9-5=4
			sqlTok('VAR',    26, 26, 2, 11),
			sqlTok('EQ',     28, 28, 2, 13),
			sqlTok('NUMBER', 30, 30, 2, 15),
		];
		const v = runRule(indentWhereRule, sql, toks);
		expect(v).toHaveLength(1);
	});

	it('falls back to SELECT when FROM is missing', () => {
		const sql = 'select 1\n    where false';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('NUMBER',  7,  7, 0, 8),
			sqlTok('WHERE',  13, 17, 1, 9),   // start col 9-5=4, should be 0
			sqlTok('VAR',    19, 23, 1, 15),
		];
		const v = runRule(indentWhereRule, sql, toks);
		expect(v).toHaveLength(1);
	});
});

// ── GROUP BY ───────────────────────────────────────────────────────────────

describe('ninja.layout.indent-group-by', () => {
	it('no violation when GROUP BY matches WHERE indent', () => {
		const sql = 'select *\nfrom t\nwhere x\ngroup by 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 1, 4),
			sqlTok('VAR',     14, 14, 1, 6),
			sqlTok('WHERE',   16, 20, 2, 5),
			sqlTok('VAR',     22, 22, 2, 7),
			sqlTok('GROUP_BY', 24, 31, 3, 8),
			sqlTok('NUMBER',  33, 33, 3, 10),
		];
		expect(runRule(indentGroupByRule, sql, toks)).toHaveLength(0);
	});

	it('flags GROUP BY when indented past preceding peer', () => {
		const sql = 'select *\nfrom t\n    group by 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 1, 4),
			sqlTok('VAR',     14, 14, 1, 6),
			sqlTok('GROUP_BY', 20, 27, 2, 12),  // start col 12-8=4
			sqlTok('NUMBER',  29, 29, 2, 14),
		];
		const v = runRule(indentGroupByRule, sql, toks);
		expect(v).toHaveLength(1);
	});

	it('also handles the split GROUP token form', () => {
		// Some dialects emit GROUP + BY separately.
		const sql = 'select *\nfrom t\n    group by 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('STAR',   7,  7, 0, 8),
			sqlTok('FROM',   9, 12, 1, 4),
			sqlTok('VAR',   14, 14, 1, 6),
			sqlTok('GROUP', 20, 24, 2, 9),   // start col 9-5=4
			sqlTok('BY',    26, 27, 2, 12),
			sqlTok('NUMBER', 29, 29, 2, 14),
		];
		const v = runRule(indentGroupByRule, sql, toks);
		expect(v).toHaveLength(1);
	});
});

// ── HAVING ─────────────────────────────────────────────────────────────────

describe('ninja.layout.indent-having', () => {
	it('no violation when HAVING matches GROUP BY indent', () => {
		const sql = 'select *\nfrom t\ngroup by 1\nhaving count(*) > 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 1, 4),
			sqlTok('VAR',     14, 14, 1, 6),
			sqlTok('GROUP_BY', 16, 23, 2, 8),
			sqlTok('NUMBER',  25, 25, 2, 10),
			sqlTok('HAVING',  27, 32, 3, 6),
			sqlTok('VAR',     34, 38, 3, 12),
			sqlTok('L_PAREN', 39, 39, 3, 13),
			sqlTok('STAR',    40, 40, 3, 14),
			sqlTok('R_PAREN', 41, 41, 3, 15),
			sqlTok('GT',      43, 43, 3, 17),
			sqlTok('NUMBER',  45, 45, 3, 19),
		];
		expect(runRule(indentHavingRule, sql, toks)).toHaveLength(0);
	});
});

// ── ORDER BY ───────────────────────────────────────────────────────────────

describe('ninja.layout.indent-order-by', () => {
	it('flags ORDER BY indented past FROM', () => {
		const sql = 'select *\nfrom t\n    order by 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 1, 4),
			sqlTok('VAR',     14, 14, 1, 6),
			sqlTok('ORDER_BY', 20, 27, 2, 12),  // start col 4
			sqlTok('NUMBER',  29, 29, 2, 14),
		];
		const v = runRule(indentOrderByRule, sql, toks);
		expect(v).toHaveLength(1);
	});
});

// ── LIMIT ──────────────────────────────────────────────────────────────────

describe('ninja.layout.indent-limit', () => {
	it('flags LIMIT indented past ORDER BY', () => {
		const sql = 'select *\nfrom t\norder by 1\n    limit 10';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('STAR',     7,  7, 0, 8),
			sqlTok('FROM',     9, 12, 1, 4),
			sqlTok('VAR',     14, 14, 1, 6),
			sqlTok('ORDER_BY', 16, 23, 2, 8),
			sqlTok('NUMBER',  25, 25, 2, 10),
			sqlTok('LIMIT',   31, 35, 3, 9),    // start col 9-5=4, should be 0
			sqlTok('NUMBER',  37, 38, 3, 12),
		];
		const v = runRule(indentLimitRule, sql, toks);
		expect(v).toHaveLength(1);
	});

	it('no violation when LIMIT is after SELECT only (no ORDER BY)', () => {
		const sql = 'select *\nfrom t\nlimit 10';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 1, 6),
			sqlTok('LIMIT',  16, 20, 2, 5),
			sqlTok('NUMBER', 22, 23, 2, 8),
		];
		expect(runRule(indentLimitRule, sql, toks)).toHaveLength(0);
	});
});

// ── Set operators ──────────────────────────────────────────────────────────

describe('ninja.layout.indent-set-op', () => {
	it('no violation when UNION ALL matches SELECT indent', () => {
		// select 1
		// union all
		// select 2
		const sql = 'select 1\nunion all\nselect 2';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 1, 9),  // start col 0
			sqlTok('SELECT',   19, 24, 2, 6),
			sqlTok('NUMBER',   26, 26, 2, 8),
		];
		expect(runRule(indentSetOpRule, sql, toks)).toHaveLength(0);
	});

	it('flags UNION indented past SELECT', () => {
		const sql = 'select 1\n    union all\nselect 2';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 13, 21, 1, 13),  // start col 13-9=4
			sqlTok('SELECT',   23, 28, 2, 6),
			sqlTok('NUMBER',   30, 30, 2, 8),
		];
		const v = runRule(indentSetOpRule, sql, toks);
		expect(v).toHaveLength(1);
	});

	it('chained UNION ALL stays aligned via set-op governor chain', () => {
		// Second UNION ALL's governor is the first UNION ALL (same level).
		const sql = 'select 1\nunion all\nselect 2\nunion all\nselect 3';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 1, 9),
			sqlTok('SELECT',   19, 24, 2, 6),
			sqlTok('NUMBER',   26, 26, 2, 8),
			sqlTok('UNION_ALL', 28, 36, 3, 9),
			sqlTok('SELECT',   38, 43, 4, 6),
			sqlTok('NUMBER',   45, 45, 4, 8),
		];
		expect(runRule(indentSetOpRule, sql, toks)).toHaveLength(0);
	});
});
