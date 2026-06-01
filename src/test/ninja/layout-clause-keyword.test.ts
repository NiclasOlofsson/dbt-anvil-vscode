import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { clauseKeywordRule } from '../../ninja/rules/layout-clause-keyword';

const RULE = 'ninja.layout.clause-keyword';

function check(sql: string, ...tokens: ReturnType<typeof sqlTok>[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return clauseKeywordRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation when WHERE is alone on its own line', () => {
		// Canonical layout — WHERE leads its clause on a fresh line. The rule
		// must NOT also flag this as "trailing" just because nothing follows
		// the keyword on the same line.
		const sql = 'select 1\nfrom t\nwhere\n    x = 1';
		// WHERE at line 2, col 0..5 (1-based exclusive end = 5)
		const where = sqlTok('WHERE', 17, 21, 2, 5);
		expect(check(sql, where)).toHaveLength(0);
	});

	it('no violation when WHERE leads its line with content after', () => {
		const sql = 'select 1\nfrom t\nwhere x = 1';
		// where at line 2, col 0..5
		const where = sqlTok('WHERE', 17, 21, 2, 5);
		expect(check(sql, where)).toHaveLength(0);
	});

	it('flags WHERE that trails after content with nothing after on the same line', () => {
		// `select 1 from t where\n    x = 1` — WHERE has content before it
		// (isLeading=false) and nothing after on its line (isTrailing=true).
		// That's the canonical "should-have-been-on-the-next-line" shape.
		const sql = 'select 1 from t where\n    x = 1';
		const where = sqlTok('WHERE', 16, 20, 0, 21);
		const v = check(sql, where);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('start of the next line');
	});

	it('no violation when GROUP / ORDER / HAVING / LIMIT / QUALIFY are alone on their lines', () => {
		// All clause keywords that the rule covers. Each on its own line —
		// must not fire.
		const sql = [
			'select 1',
			'from t',
			'where',
			'    x = 1',
			'group',
			'    by 1',
			'having',
			'    count(*) > 0',
			'order',
			'    by 1',
			'limit',
			'    10',
			'qualify',
			'    row_number() over (partition by id) = 1',
		].join('\n');
		// Token positions follow line numbers; col is 1-based end col matching the keyword length.
		const lineOffsets: number[] = [];
		let off = 0;
		for (const line of sql.split('\n')) {
			lineOffsets.push(off);
			off += line.length + 1;
		}
		// Tokens: only the clause keywords.
		const toks = [
			sqlTok('WHERE',   lineOffsets[2],     lineOffsets[2] + 4,  2, 5),
			sqlTok('GROUP',   lineOffsets[4],     lineOffsets[4] + 4,  4, 5),
			sqlTok('HAVING',  lineOffsets[6],     lineOffsets[6] + 5,  6, 6),
			sqlTok('ORDER',   lineOffsets[8],     lineOffsets[8] + 4,  8, 5),
			sqlTok('LIMIT',   lineOffsets[10],    lineOffsets[10] + 4, 10, 5),
			sqlTok('QUALIFY', lineOffsets[12],    lineOffsets[12] + 6, 12, 7),
		];
		expect(check(sql, ...toks)).toHaveLength(0);
	});
});
