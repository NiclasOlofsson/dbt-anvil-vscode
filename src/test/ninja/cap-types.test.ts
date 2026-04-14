import { describe, it, expect } from 'vitest';
import { run, violationsFor, capCfg, emptyModel } from './helpers';

const RULE = 'ninja.cap.types';

describe(RULE, () => {
	// ── Policy: lower ──────────────────────────────────────────────────────

	it('flags uppercase type when policy is lower', () => {
		const v = violationsFor(run('select cast(x as VARCHAR)'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('varchar');
	});

	it('passes lowercase type', () => {
		const v = violationsFor(run('select cast(x as integer)'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags multiple uppercase types', () => {
		const sql = 'select cast(x as VARCHAR), cast(y as INT), cast(z as BOOLEAN)';
		const v = violationsFor(run(sql), RULE);
		expect(v.length).toBe(3);
	});

	// ── Policy: upper ──────────────────────────────────────────────────────

	it('flags lowercase type when policy is upper', () => {
		const v = violationsFor(run('select cast(x as int)', capCfg('types', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('INT');
	});

	it('passes uppercase type when policy is upper', () => {
		const v = violationsFor(run('select cast(x as INT)', capCfg('types', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent type casing', () => {
		const v = violationsFor(run('select cast(x as int), cast(y as INT)', capCfg('types', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('int');
	});

	it('passes consistent type casing', () => {
		const v = violationsFor(run('select cast(x as int), cast(y as varchar)', capCfg('types', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Various SQL types ──────────────────────────────────────────────────

	it('detects BIGINT', () => {
		const v = violationsFor(run('select cast(x as BIGINT)'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('bigint');
	});

	it('detects DECIMAL', () => {
		const v = violationsFor(run('select cast(x as DECIMAL)'), RULE);
		expect(v.length).toBe(1);
	});

	it('detects TIMESTAMP', () => {
		const v = violationsFor(run('select cast(x as TIMESTAMP)'), RULE);
		expect(v.length).toBe(1);
	});

	it('detects BOOLEAN', () => {
		const v = violationsFor(run('select cast(x as BOOLEAN)'), RULE);
		expect(v.length).toBe(1);
	});

	it('detects JSON/JSONB', () => {
		const v = violationsFor(run('select cast(x as JSON)'), RULE);
		expect(v.length).toBe(1);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('fix targets the type keyword range', () => {
		const v = violationsFor(run('select cast(x as VARCHAR)'), RULE);
		expect(v[0].range.start.character).toBe(17);
		expect(v[0].range.end.character).toBe(24);
	});

	// ── Identifier skipping ────────────────────────────────────────────────

	it('skips words at identifier token positions', () => {
		const model = {
			...emptyModel,
			tokens: [{ type: 'column_ref' as const, name: 'int', line: 0, col: 17, endCol: 20 }],
		};
		const v = violationsFor(run('select cast(x as int)', capCfg('types', 'upper'), model), RULE);
		expect(v.length).toBe(0);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});
});
