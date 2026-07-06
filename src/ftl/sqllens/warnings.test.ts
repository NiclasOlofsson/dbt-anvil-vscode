import { describe, expect, it } from 'vitest';
import type { Diagnostic, SyntaxDiagnostic } from 'sqllens';
import { collectWarnings, mapQualifyDiagnostics, mapSyntaxDiagnostics } from './warnings';

describe('mapSyntaxDiagnostics', () => {
	it('converts sqllens (1-based line / 0-based col) to the ParseWarning 0-based convention', () => {
		// A synthetic diagnostic pinned to a hand-computed position.
		const diag: SyntaxDiagnostic = { message: 'extraneous input \'orders\'', line: 1, column: 13, offset: 13, length: 6 };
		expect(mapSyntaxDiagnostics([diag])).toEqual([
			{ type: 'syntax_error', message: 'extraneous input \'orders\'', line: 0, col: 13, endCol: 19 },
		]);
	});

	it('maps a real parse error to a hand-computed line/col/endCol', () => {
		// `SELECT * FRM orders` — the offending token is `orders`, 0-based chars 13..18.
		//  S E L E C T _ * _ F  R  M  _  o  r  s ...   → o starts at column 13
		//  0 1 2 3 4 5 6 7 8 9 10 11 12 13
		const warnings = collectWarnings('SELECT * FRM orders', 'databricks');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ type: 'syntax_error', line: 0, col: 13, endCol: 19 });
		expect(warnings[0].message).toContain('orders');
	});
});

describe('mapQualifyDiagnostics', () => {
	it('maps a qualify Diagnostic to a scope_warning, carrying start/end columns straight through', () => {
		const diag: Diagnostic = {
			kind: 'unknown-column',
			message: 'Unknown column: nope',
			line: 1,
			column: 7,
			endLine: 1,
			endColumn: 11,
		};
		expect(mapQualifyDiagnostics([diag])).toEqual([
			{ type: 'scope_warning', message: 'Unknown column: nope', line: 0, col: 7, endCol: 11 },
		]);
	});

	it('emits a scope_warning for an unknown column resolved against a schema', () => {
		// `SELECT nope FROM orders` parses clean; qualify objects that `nope` is not in `orders`.
		//  S E L E C T _ n o r  s ...  → nope starts at column 7, ends (exclusive) at 11
		const warnings = collectWarnings('SELECT nope FROM orders', 'databricks', { orders: { id: 'bigint' } });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ type: 'scope_warning', line: 0, col: 7, endCol: 11 });
		expect(warnings[0].message).toContain('nope');
	});
});

describe('collectWarnings', () => {
	it('returns no warnings for clean SQL with a complete schema', () => {
		expect(collectWarnings('SELECT id FROM orders', 'databricks', { orders: { id: 'bigint' } })).toEqual([]);
	});

	it('suppresses scope warnings when the parse has syntax errors', () => {
		// A syntax error short-circuits: only syntax_error warnings come back, never scope noise
		// derived from a broken IR.
		const warnings = collectWarnings('SELECT * FRM orders', 'databricks');
		expect(warnings.every(w => w.type === 'syntax_error')).toBe(true);
	});

	it('produces no scope warnings without a schema (nothing to resolve against)', () => {
		expect(collectWarnings('SELECT anything FROM orders', 'databricks')).toEqual([]);
	});
});
