import * as path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mockDocument, cfg, applyEditsToText } from './helpers';
import { operatorPositionRule } from '../../ninja/rules/convention-operator-position';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';
import type { AdapterContext } from '../../ftl/ftl-document-parser';
import { FixAction } from '../../ninja/violation';
import type { DocumentModel } from '../../services/parse-service';

const RULE = 'ninja.convention.operator-position';

const PYODIDE_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');
const ANSI_CONTEXT: AdapterContext = { adapterType: 'ansi' };

describe(RULE, () => {
	let parser: FtlDocumentParser;

	beforeAll(async () => {
		parser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, ANSI_CONTEXT);
		await parser.ready();
	}, 60_000);

	afterAll(() => {
		parser.dispose();
	});

	async function check(sql: string, operatorPosition: 'trailing' | 'leading') {
		const m: DocumentModel = await parser.parse(sql);
		const doc = mockDocument(sql);
		return operatorPositionRule.check({
			model: m,
			document: doc,
			config: cfg({ layout: { commaPosition: 'trailing', operatorPosition } }),
		});
	}

	// ── Trailing policy ─────────────────────────────────────────────────────

	it('no violation with trailing operators in trailing mode', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1 AND\n  b = 2';
		expect(await check(sql, 'trailing')).toHaveLength(0);
	}, 30_000);

	it('flags leading operators when trailing policy', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('end of the previous line');
		expect(v[0].message).toContain('AND');
	}, 30_000);

	// ── Leading policy ──────────────────────────────────────────────────────

	it('no violation with leading operators in leading mode', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		expect(await check(sql, 'leading')).toHaveLength(0);
	}, 30_000);

	it('flags trailing operators when leading policy', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1 AND\n  b = 2';
		const v = await check(sql, 'leading');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('start of the next line');
	}, 30_000);

	// ── OR ───────────────────────────────────────────────────────────────────

	it('flags leading OR when trailing policy', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  OR b = 2';
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OR');
	}, 30_000);

	// ── Edge cases ──────────────────────────────────────────────────────────

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select * from t where a = 1 AND b = 2');
		const m: DocumentModel = { tokens: [], ctes: [], refs: [], sources: [], finalSelect: undefined, finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		expect(operatorPositionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations on single-line queries', async () => {
		const sql = 'select * from t where a = 1 AND b = 2';
		expect(await check(sql, 'trailing')).toHaveLength(0);
		expect(await check(sql, 'leading')).toHaveLength(0);
	}, 30_000);

	// ── Outcome assertions (applyEditsToText) ────────────────────────────────

	it('applying trailing fix moves leading AND to end of previous line', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  AND b = 2';
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toBe('select *\nfrom t\nwhere a = 1 AND\n  b = 2');
	}, 30_000);

	it('applying leading fix moves trailing AND to start of next line', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1 AND\n  b = 2';
		const v = await check(sql, 'leading');
		expect(v).toHaveLength(1);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toBe('select *\nfrom t\nwhere a = 1\n  AND b = 2');
	}, 30_000);

	it('applying trailing fix yields correct SQL for OR', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1\n  OR b = 2';
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toBe('select *\nfrom t\nwhere a = 1 OR\n  b = 2');
	}, 30_000);

	it('applying leading fix yields correct SQL for OR', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1 OR\n  b = 2';
		const v = await check(sql, 'leading');
		expect(v).toHaveLength(1);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toBe('select *\nfrom t\nwhere a = 1\n  OR b = 2');
	}, 30_000);

	// ── Comment-aware insert positions ────────────────────────────────────────

	it('trailing mode: inserts AND before trailing SQL comment', async () => {
		const sql = 'select *\nfrom t\nwhere a = 1 -- a comment\n  AND b = 2';
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		const insert = (v[0].action as FixAction).edits.find(e => e.newText === ' AND');
		expect(insert).toBeDefined();
		// Insert must land before the comment text, not at the end of the raw line
		expect(insert!.range.start.character).toBeLessThan('where a = 1 -- a comment'.length);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toContain('AND -- a comment');
	}, 30_000);

	it('trailing mode: skips pure comment lines and inserts AND on the last SQL line', async () => {
		// Line 2 is the last SQL line before three comment-only lines and the AND on line 6.
		// The fix must insert AND at end of line 2, not on any comment line (3-5).
		const sql = [
			'select *',
			'from t',
			'where cp.is_deleted = false',
			'-- Positive quantities',
			'-- Return orders',
			'-- Negative quantities',
			'  AND cp.qty > 0',
		].join('\n');
		const v = await check(sql, 'trailing');
		expect(v).toHaveLength(1);
		const insert = (v[0].action as FixAction).edits.find(e => e.newText === ' AND');
		expect(insert).toBeDefined();
		// Must target line 2 (the SQL line with 'false'), NOT any comment line (3-5)
		expect(insert!.range.start.line).toBe(2);
		const result = applyEditsToText(sql, (v[0].action as FixAction).edits);
		expect(result).toContain('false AND');
	}, 30_000);
});
