import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';
import type { NinjaConfig } from '../../../ninja/config';

const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

async function reflow(sql: string, config: NinjaConfig): Promise<string> {
	const doc = mockDocument(sql);
	const parsed = await parser.parse(sql);
	const result = reflowDocument(doc, parsed, config);
	// Fall back to source when reflow is a no-op (already canonical).
	return result.edit?.newText ?? doc.getText();
}

/** Blank lines strictly between the first line starting with `a` and the next starting with `b`. */
function blanksBetween(rendered: string, a: string, b: string): number {
	const lines = rendered.split('\n');
	const i = lines.findIndex(l => l.trim().startsWith(a));
	const j = lines.findIndex((l, k) => k > i && l.trim().startsWith(b));
	if (i < 0 || j < 0) throw new Error(`markers not found (${a}@${i}, ${b}@${j}):\n${rendered}`);
	let blanks = 0;
	for (let k = i + 1; k < j; k++) if (lines[k].trim() === '') blanks++;
	return blanks;
}

// One-target-per-line, so a blank between targets has a line to occupy.
const WRAP = { layout: { alwaysWrap: { select: true } } };

// A deliberate blank the author placed between two select targets must survive a
// reflow REGARDLESS of paren depth — top level, CTE body, or subquery.
describe('reflow blank-line preservation — scope (any paren depth)', () => {
	it('preserves a blank between top-level select targets', async () => {
		const sql = 'select\naaa,\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg(WRAP)), 'aaa', 'bbb')).toBe(1);
	});

	it('preserves a blank between select targets inside a CTE body', async () => {
		const sql = 'with cte as (\nselect\naaa,\n\nbbb\nfrom t\n)\nselect * from cte';
		expect(blanksBetween(await reflow(sql, cfg(WRAP)), 'aaa', 'bbb')).toBe(1);
	});

	it('preserves a blank between select targets inside a subquery', async () => {
		const sql = 'select * from (\nselect\naaa,\n\nbbb\nfrom t\n) sub';
		expect(blanksBetween(await reflow(sql, cfg(WRAP)), 'aaa', 'bbb')).toBe(1);
	});
});

// The formatter must keep up to `maxBlankLines` blanks, not collapse every run to one.
describe('reflow blank-line preservation — count honours maxBlankLines', () => {
	it('1 blank stays 1 (max 2)', async () => {
		const sql = 'select\naaa,\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 2 })), 'aaa', 'bbb')).toBe(1);
	});

	it('2 blanks stay 2 (max 2)', async () => {
		const sql = 'select\naaa,\n\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 2 })), 'aaa', 'bbb')).toBe(2);
	});

	it('3 blanks clamp to 2 (max 2)', async () => {
		const sql = 'select\naaa,\n\n\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 2 })), 'aaa', 'bbb')).toBe(2);
	});

	it('3 blanks stay 3 (max 3)', async () => {
		const sql = 'select\naaa,\n\n\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 3 })), 'aaa', 'bbb')).toBe(3);
	});

	it('2 blanks clamp to 1 (max 1)', async () => {
		const sql = 'select\naaa,\n\n\nbbb\nfrom t';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 1 })), 'aaa', 'bbb')).toBe(1);
	});
});

// Both fixes together: multiple blanks, honoured to the cap, inside parens.
describe('reflow blank-line preservation — scope × count', () => {
	it('2 blanks inside a CTE body stay 2 (max 2)', async () => {
		const sql = 'with cte as (\nselect\naaa,\n\n\nbbb\nfrom t\n)\nselect * from cte';
		expect(blanksBetween(await reflow(sql, cfg({ ...WRAP, maxBlankLines: 2 })), 'aaa', 'bbb')).toBe(2);
	});
});
