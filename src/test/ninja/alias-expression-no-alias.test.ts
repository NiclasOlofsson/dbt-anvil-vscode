import { describe, expect, it } from 'vitest';
import { model, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { FinalSelectInfo } from '../../services/parse-service';

const RULE = 'ninja.aliasing.expression-no-alias';

function check(finalSelect: FinalSelectInfo): NinjaViolation[] {
	const m = model({ finalSelect });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

function fs(columns: FinalSelectInfo['columns']): FinalSelectInfo {
	return { line: 0, col: 0, endLine: 0, endCol: 10, columns };
}

describe(RULE, () => {
	it('flags expression without alias', () => {
		const v = check(fs([
			{ name: 'count(*)', line: 0, col: 7, endLine: 0, endCol: 15, expression: 'count(*)' },
		]));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('count(*)');
	});

	it('no violation when expression has alias', () => {
		expect(check(fs([
			{ name: 'total', line: 0, col: 7, endLine: 0, endCol: 15, expression: 'count(*)', aliasLine: 0, aliasCol: 17, aliasEndCol: 22 },
		]))).toHaveLength(0);
	});

	it('no violation for plain columns', () => {
		expect(check(fs([
			{ name: 'id', line: 0, col: 7, endLine: 0, endCol: 9 },
		]))).toHaveLength(0);
	});

	it('no violation when no finalSelect', () => {
		const m = model({});
		const result = run('select 1', {}, m);
		expect(violationsFor(result, RULE)).toHaveLength(0);
	});

	it('snippet fix pre-fills the column name when it is a valid identifier', () => {
		const v = check(fs([
			{ name: 'team', line: 0, col: 7, endLine: 0, endCol: 13, expression: 'team' },
		]));
		expect(v).toHaveLength(1);
		expect(v[0].fix).toBeUndefined();
		expect(v[0].snippetFix).toBeDefined();
		expect(v[0].snippetFix!.snippet).toBe(' as ${1:team}');
		expect(v[0].snippetFix!.position.line).toBe(0);
		expect(v[0].snippetFix!.position.character).toBe(13);
	});

	it('snippet fix uses generic placeholder when col name is not a safe identifier (e.g. count(*))', () => {
		const v = check(fs([
			{ name: 'count(*)', line: 0, col: 7, endLine: 0, endCol: 15, expression: 'count(*)' },
		]));
		expect(v).toHaveLength(1);
		expect(v[0].fix).toBeUndefined();
		expect(v[0].snippetFix).toBeDefined();
		expect(v[0].snippetFix!.snippet).toBe(' as ${1:alias}');
		expect(v[0].snippetFix!.position.line).toBe(0);
		expect(v[0].snippetFix!.position.character).toBe(15);
	});
});
