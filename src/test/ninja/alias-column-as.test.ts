import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { columnAsRule } from '../../ninja/rules/alias-column-as';
import type { FinalSelectInfo, FinalSelectColumnInfo } from '../../services/parse-service';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.aliasing.column-as';

function finalCol(name: string, line: number, col: number, endCol: number, opts?: {
	expression?: string;
	table?: string;
	aliasLine?: number;
	aliasCol?: number;
	aliasEndCol?: number;
}): FinalSelectColumnInfo {
	return {
		name,
		line,
		col,
		endLine: opts?.aliasLine ?? line,
		endCol: opts?.aliasEndCol ?? endCol,
		expression: opts?.expression,
		table: opts?.table,
		aliasLine: opts?.aliasLine,
		aliasCol: opts?.aliasCol,
		aliasEndCol: opts?.aliasEndCol,
	};
}

function check(sql: string, finalSelect: FinalSelectInfo, sqlTokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ finalSelect, sqlTokens });
	return columnAsRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation with explicit AS', () => {
		const sql = 'select id AS user_id from t';
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 21,
			columns: [finalCol('user_id', 0, 7, 21, { expression: 'id', aliasLine: 0, aliasCol: 15, aliasEndCol: 22 })],
		};
		const tokens: SqlToken[] = [sqlTok('ALIAS', 12, 13, 0, 14)]; // AS token
		expect(check(sql, fs, tokens)).toHaveLength(0);
	});

	it('flags implicit alias (no AS keyword)', () => {
		const sql = 'select id user_id from t';
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 18,
			columns: [finalCol('user_id', 0, 7, 18, { expression: 'id', aliasLine: 0, aliasCol: 10, aliasEndCol: 17 })],
		};
		// No ALIAS token
		const tokens: SqlToken[] = [sqlTok('SELECT', 0, 5, 0, 6)];
		const v = check(sql, fs, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('user_id');
		expect(v[0].message).toContain('AS');
	});

	it('provides auto-fix inserting AS', () => {
		const sql = 'select id user_id from t';
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 18,
			columns: [finalCol('user_id', 0, 7, 18, { expression: 'id', aliasLine: 0, aliasCol: 10, aliasEndCol: 17 })],
		};
		const tokens: SqlToken[] = [sqlTok('SELECT', 0, 5, 0, 6)];
		const v = check(sql, fs, tokens);
		expect(v[0].fix).toBeDefined();
		expect(v[0].fix![0].newText).toBe('AS ');
		expect(v[0].fix![0].range.start.character).toBe(10);
	});

	it('no violation when column has no alias', () => {
		const sql = 'select id from t';
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 9,
			columns: [finalCol('id', 0, 7, 9)],
		};
		expect(check(sql, fs, [sqlTok('SELECT', 0, 5, 0, 6)])).toHaveLength(0);
	});

	it('no violations without finalSelect', () => {
		const doc = mockDocument('select 1');
		const m = model({ sqlTokens: [sqlTok('SELECT', 0, 5, 0, 6)] });
		expect(columnAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 8,
			columns: [finalCol('x', 0, 7, 8, { aliasLine: 0, aliasCol: 7, aliasEndCol: 8 })],
		};
		const m = model({ finalSelect: fs });
		expect(columnAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('flags multiple implicit aliases', () => {
		const sql = 'select a x, b y from t';
		const fs: FinalSelectInfo = {
			line: 0, col: 0, endLine: 0, endCol: 14,
			columns: [
				finalCol('x', 0, 7, 10, { expression: 'a', aliasLine: 0, aliasCol: 9, aliasEndCol: 10 }),
				finalCol('y', 0, 12, 14, { expression: 'b', aliasLine: 0, aliasCol: 14, aliasEndCol: 15 }),
			],
		};
		const tokens: SqlToken[] = [sqlTok('SELECT', 0, 5, 0, 6)];
		expect(check(sql, fs, tokens)).toHaveLength(2);
	});
});
