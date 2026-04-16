import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.indent';

describe(RULE, () => {
	// ── Wrong unit type ────────────────────────────────────────────────────

	it('flags tabs when unit is space', () => {
		const v = violationsFor(run('select\n\t1\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('tabs');
	});

	it('flags spaces when unit is tab', () => {
		const v = violationsFor(run('select\n    1\n', { indentation: { unit: 'tab', size: 4 } }), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('spaces');
	});

	// ── Mixed indentation ──────────────────────────────────────────────────

	it('flags mixed spaces and tabs', () => {
		const v = violationsFor(run('select\n \t1\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('Mixed');
	});

	it('flags mixed tabs and spaces', () => {
		const v = violationsFor(run('select\n\t 1\n'), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('Mixed');
	});

	// ── Non-multiple size ──────────────────────────────────────────────────

	it('flags non-multiple-of-size indentation', () => {
		const v = violationsFor(run('select\n   1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('3 spaces');
	});

	it('flags 5-space indent when size is 4', () => {
		const v = violationsFor(run('select\n     1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('5 spaces');
	});

	it('flags 2-space indent when size is 4', () => {
		const v = violationsFor(run('select\n  1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('2 spaces');
	});

	// ── Correct indentation ────────────────────────────────────────────────

	it('passes correct space indentation', () => {
		const v = violationsFor(run('select\n    1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(0);
	});

	it('passes correct 2-space indentation', () => {
		const v = violationsFor(run('select\n  1\n', { indentation: { unit: 'space', size: 2 } }), RULE);
		expect(v.length).toBe(0);
	});

	it('passes correct tab indentation', () => {
		const v = violationsFor(run('select\n\t1\n', { indentation: { unit: 'tab', size: 4 } }), RULE);
		expect(v.length).toBe(0);
	});

	it('passes double tab indentation', () => {
		const v = violationsFor(run('select\n\t\t1\n', { indentation: { unit: 'tab', size: 4 } }), RULE);
		expect(v.length).toBe(0);
	});

	it('passes 8-space indentation with size 4', () => {
		const v = violationsFor(run('select\n        1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('fixes tabs to spaces', () => {
		const v = violationsFor(run('select\n\t1\n'), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('    ');
	});

	it('fixes spaces to tabs', () => {
		const v = violationsFor(run('select\n    1\n', { indentation: { unit: 'tab', size: 4 } }), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('\t');
	});

	it('fixes non-multiple spacing to nearest multiple', () => {
		const v = violationsFor(run('select\n   1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('    ');
	});

	it('fix range covers only the indentation', () => {
		const v = violationsFor(run('select\n\t1\n'), RULE);
		expect(v[0].range.start.line).toBe(1);
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].range.end.character).toBe(1); // just the tab
	});

	// ── Blank lines and non-indented lines ─────────────────────────────────

	it('skips blank lines', () => {
		const v = violationsFor(run('select\n\n    1\n', { indentation: { unit: 'space', size: 4 } }), RULE);
		expect(v.length).toBe(0);
	});

	it('skips non-indented lines', () => {
		const v = violationsFor(run('select\n1\n'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Multiple violations ────────────────────────────────────────────────

	it('flags multiple lines with wrong indentation', () => {
		const sql = 'select\n\t1,\n\t2,\n\t3\n';
		const v = violationsFor(run(sql), RULE);
		expect(v.length).toBe(3);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('handles whitespace-only lines', () => {
		const v = violationsFor(run('select\n    \n    1\n'), RULE);
		// whitespace-only line is blank → skipped
		expect(v.length).toBe(0);
	});
});
