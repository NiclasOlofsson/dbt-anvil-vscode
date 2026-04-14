import { describe, it, expect } from 'vitest';
import { run, violationsFor, capCfg, emptyModel, mockDocument, cfg } from './helpers';
import { DEFAULT_CONFIG } from '../../ninja/config';
import { runNinja } from '../../ninja/engine';

const RULE = 'ninja.cap.keywords';

describe(RULE, () => {
	// ── Policy: lower ──────────────────────────────────────────────────────

	it('flags uppercase keyword when policy is lower', () => {
		const v = violationsFor(run('SELECT 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('select');
	});

	it('passes when keyword matches lower policy', () => {
		const v = violationsFor(run('select 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(0);
	});

	it('flags multiple uppercase keywords', () => {
		const v = violationsFor(run('SELECT 1 FROM t WHERE x = 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(3); // SELECT, FROM, WHERE
	});

	it('flags mixed-case keyword when policy is lower', () => {
		const v = violationsFor(run('Select 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('select');
	});

	// ── Policy: upper ──────────────────────────────────────────────────────

	it('flags lowercase keyword when policy is upper', () => {
		const v = violationsFor(run('select 1', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('SELECT');
	});

	it('passes when keyword matches upper policy', () => {
		const v = violationsFor(run('SELECT 1', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	it('flags mixed-case keyword when policy is upper', () => {
		const v = violationsFor(run('Select 1 From t', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(2);
		expect(v[0].fix![0].newText).toBe('SELECT');
		expect(v[1].fix![0].newText).toBe('FROM');
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent keywords (first lower, then upper)', () => {
		const v = violationsFor(run('select 1\nSELECT 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('select');
	});

	it('flags inconsistent keywords (first upper, then lower)', () => {
		const v = violationsFor(run('SELECT 1\nselect 2', capCfg('keywords', 'upper')), RULE);
		const v2 = violationsFor(run('SELECT 1\nselect 2', capCfg('keywords', 'consistent')), RULE);
		expect(v2.length).toBe(1);
		expect(v2[0].fix![0].newText).toBe('SELECT');
	});

	it('passes consistent keywords (all lower)', () => {
		const v = violationsFor(run('select 1\nselect 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	it('passes consistent keywords (all upper)', () => {
		const v = violationsFor(run('SELECT 1\nSELECT 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	it('tracks consistency per-keyword independently', () => {
		// 'select' first lower, 'from' first upper — both consistent within themselves
		const v = violationsFor(run('select 1 FROM t\nselect 2 FROM t2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('provides auto-fix with correct range', () => {
		const r = run('SELECT 1');
		const v = violationsFor(r, RULE);
		expect(v[0].fix).toBeDefined();
		expect(v[0].fix![0].newText).toBe('select');
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].range.end.character).toBe(6);
	});

	it('fix targets the correct word on multi-keyword line', () => {
		const v = violationsFor(run('SELECT 1 FROM t', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(2);
		// SELECT at col 0
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].fix![0].newText).toBe('select');
		// FROM at col 9
		expect(v[1].range.start.character).toBe(9);
		expect(v[1].fix![0].newText).toBe('from');
	});

	// ── Identifier skipping ────────────────────────────────────────────────

	it('skips words at identifier token positions', () => {
		const model = {
			...emptyModel,
			tokens: [{ type: 'column_ref' as const, name: 'select', line: 0, col: 7, endCol: 13 }],
		};
		// 'select' at position 0:0 is a keyword, 'select' at 0:7 is an identifier token
		const v = violationsFor(run('select select from t', capCfg('keywords', 'upper'), model), RULE);
		// Should flag 'select' at col 0 and 'from' at col 14, but NOT 'select' at col 7
		const flaggedCols = v.map(x => x.range.start.character);
		expect(flaggedCols).not.toContain(7);
	});

	// ── Multi-line ─────────────────────────────────────────────────────────

	it('flags keywords across multiple lines', () => {
		const sql = 'SELECT\n    1\nFROM\n    t\nWHERE\n    x = 1\n';
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(3);
		expect(v[0].range.start.line).toBe(0);
		expect(v[1].range.start.line).toBe(2);
		expect(v[2].range.start.line).toBe(4);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag numbers or symbols', () => {
		const v = violationsFor(run('select 123, *, \'hello\'', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(0);
	});

	it('handles CTE with keyword-like names', () => {
		const sql = 'with orders as (select 1)\nselect * from orders\n';
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		// 'with', 'as', 'select', 'from' are all lower — should pass
		expect(v.length).toBe(0);
	});
});
