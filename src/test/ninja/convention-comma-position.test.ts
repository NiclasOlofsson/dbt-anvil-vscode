import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { commaPositionRule } from '../../ninja/rules/convention-comma-position';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.convention.comma-position';

/** Build sqlTokens for commas at given positions in text. */
function findCommas(text: string): SqlToken[] {
	const tokens: SqlToken[] = [];
	const lines = text.split('\n');
	let offset = 0;
	for (let line = 0; line < lines.length; line++) {
		for (let col = 0; col < lines[line].length; col++) {
			if (lines[line][col] === ',') {
				tokens.push(sqlTok('COMMA', offset + col, offset + col, line, col + 1));
			}
		}
		offset += lines[line].length + 1;
	}
	return tokens;
}

function check(sql: string, commaPosition: 'trailing' | 'leading') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: findCommas(sql) });
	return commaPositionRule.check({
		model: m,
		document: doc,
		config: cfg({ layout: { commaPosition, operatorPosition: 'trailing' } }),
	});
}

describe(RULE, () => {
	// ── Trailing policy ─────────────────────────────────────────────────────

	it('no violation with trailing commas in trailing mode', () => {
		const sql = 'select\n  a,\n  b,\n  c\nfrom t';
		expect(check(sql, 'trailing')).toHaveLength(0);
	});

	it('flags leading commas when trailing policy', () => {
		const sql = 'select\n  a\n  ,b\n  ,c\nfrom t';
		const v = check(sql, 'trailing');
		expect(v).toHaveLength(2);
		expect(v[0].message).toContain('end of the previous line');
	});

	it('no violation for single-line commas in trailing mode', () => {
		const sql = 'select a, b, c from t';
		expect(check(sql, 'trailing')).toHaveLength(0);
	});

	// ── Leading policy ──────────────────────────────────────────────────────

	it('no violation with leading commas in leading mode', () => {
		const sql = 'select\n  a\n  ,b\n  ,c\nfrom t';
		expect(check(sql, 'leading')).toHaveLength(0);
	});

	it('flags trailing commas when leading policy', () => {
		const sql = 'select\n  a,\n  b,\n  c\nfrom t';
		const v = check(sql, 'leading');
		expect(v).toHaveLength(2);
		expect(v[0].message).toContain('start of the next line');
	});

	// ── Edge cases ──────────────────────────────────────────────────────────

	it('no violations when no sqlTokens', () => {
		const doc = mockDocument('select a, b');
		const m = model({ sqlTokens: [] });
		expect(commaPositionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations when sqlTokens undefined', () => {
		const doc = mockDocument('select a, b');
		const m = model();
		expect(commaPositionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('provides an autofix that moves the leading comma to end of previous line', () => {
		const sql = 'select\n  a\n  ,b\nfrom t';
		const v = check(sql, 'trailing');
		expect(v).toHaveLength(1);
		expect(v[0].action).toBeDefined();
		expect(v[0].action?.type).toBe('fix');
	});

	it('trailing comma before comment not flagged in trailing mode', () => {
		const sql = 'select\n  a, -- comment\n  b\nfrom t';
		expect(check(sql, 'trailing')).toHaveLength(0);
	});
});
