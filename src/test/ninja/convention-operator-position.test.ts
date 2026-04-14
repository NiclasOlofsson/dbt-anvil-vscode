import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { operatorPositionRule } from '../../ninja/rules/convention-operator-position';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.convention.operator-position';

/** Find AND/OR tokens in text via simple scanning. */
function findOperators(text: string): SqlToken[] {
	const tokens: SqlToken[] = [];
	const lines = text.split('\n');
	let offset = 0;
	for (let line = 0; line < lines.length; line++) {
		const upper = lines[line].toUpperCase();
		for (const kw of ['AND', 'OR']) {
			let idx = 0;
			while ((idx = upper.indexOf(kw, idx)) !== -1) {
				// Ensure it's a word boundary
				const before = idx > 0 ? upper[idx - 1] : ' ';
				const after = idx + kw.length < upper.length ? upper[idx + kw.length] : ' ';
				if (/\W/.test(before) && /\W/.test(after)) {
					tokens.push(sqlTok(kw, offset + idx, offset + idx + kw.length - 1, line, idx + kw.length));
				}
				idx += kw.length;
			}
		}
		offset += lines[line].length + 1;
	}
	return tokens;
}

function check(sql: string, operatorPosition: 'trailing' | 'leading') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: findOperators(sql) });
	return operatorPositionRule.check({
		model: m,
		document: doc,
		config: cfg({ layout: { commaPosition: 'trailing', operatorPosition } }),
	});
}

describe(RULE, () => {
	// ── Trailing policy ─────────────────────────────────────────────────────

	it('no violation with trailing operators in trailing mode', () => {
		const sql = 'select *\nfrom t\nwhere a = 1 AND\n  b = 2';
		expect(check(sql, 'trailing')).toHaveLength(0);
	});

	it('flags leading operators when trailing policy', () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		const v = check(sql, 'trailing');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('end of the previous line');
		expect(v[0].message).toContain('AND');
	});

	// ── Leading policy ──────────────────────────────────────────────────────

	it('no violation with leading operators in leading mode', () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		expect(check(sql, 'leading')).toHaveLength(0);
	});

	it('flags trailing operators when leading policy', () => {
		const sql = 'select *\nfrom t\nwhere a = 1 AND\n  b = 2';
		const v = check(sql, 'leading');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('start of the next line');
	});

	// ── OR ───────────────────────────────────────────────────────────────────

	it('flags leading OR when trailing policy', () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  OR b = 2';
		const v = check(sql, 'trailing');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OR');
	});

	// ── Edge cases ──────────────────────────────────────────────────────────

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select * from t where a = 1 AND b = 2');
		const m = model();
		expect(operatorPositionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations on single-line queries', () => {
		const sql = 'select * from t where a = 1 AND b = 2';
		expect(check(sql, 'trailing')).toHaveLength(0);
		expect(check(sql, 'leading')).toHaveLength(0);
	});

	it('no fix is provided', () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		const v = check(sql, 'trailing');
		if (v.length > 0) {
			expect(v[0].fix).toBeUndefined();
		}
	});
});
