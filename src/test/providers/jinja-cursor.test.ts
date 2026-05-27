import { describe, it, expect } from 'vitest';
import { isCursorInsideOpenJinjaTag, findEnclosingMacroCall } from '../../providers/sql/jinja-cursor';

describe('isCursorInsideOpenJinjaTag', () => {
	it('returns true inside an unterminated {{', () => {
		const text = 'select {{ my_macro(';
		expect(isCursorInsideOpenJinjaTag(text, text.length)).toBe(true);
	});

	it('returns true inside an unterminated {%', () => {
		const text = '{% set x = my_macro(';
		expect(isCursorInsideOpenJinjaTag(text, text.length)).toBe(true);
	});

	it('returns false after a closed {{ }}', () => {
		const text = 'select {{ ref("a") }} from t';
		expect(isCursorInsideOpenJinjaTag(text, text.length)).toBe(false);
	});

	it('returns false in plain SQL', () => {
		expect(isCursorInsideOpenJinjaTag('select 1 from t', 10)).toBe(false);
	});

	it('handles multi-line unterminated tag', () => {
		const text = 'select {{\n  my_macro(';
		expect(isCursorInsideOpenJinjaTag(text, text.length)).toBe(true);
	});

	it('returns true inside an unterminated {# comment', () => {
		const text = '{# todo: ';
		expect(isCursorInsideOpenJinjaTag(text, text.length)).toBe(true);
	});
});

describe('findEnclosingMacroCall', () => {
	it('finds a simple in-progress macro call', () => {
		const text = '{{ my_macro(';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r).toEqual({ name: 'my_macro', activeArg: 0 });
	});

	it('counts commas to compute the active argument', () => {
		const text = '{{ my_macro(\'a\', \'b\', ';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.activeArg).toBe(2);
	});

	it('finds package-qualified calls', () => {
		const text = '{{ dbt_utils.pivot(';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r).toEqual({ name: 'pivot', packageName: 'dbt_utils', activeArg: 0 });
	});

	it('ignores commas inside string literals', () => {
		const text = '{{ my_macro(\'a, b\', ';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.activeArg).toBe(1);
	});

	it('ignores parens inside string literals', () => {
		const text = '{{ my_macro(\'a (b)\', ';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.activeArg).toBe(1);
	});

	it('returns the innermost call for nested calls', () => {
		const text = '{{ outer(inner(';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.name).toBe('inner');
	});

	it('handles multi-line macro call mid-typing', () => {
		const text = '{{\n  my_macro(\n    ';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.name).toBe('my_macro');
	});

	it('works inside {% set ... = macro( %} mid-typing', () => {
		const text = '{% set rows = my_macro(';
		const r = findEnclosingMacroCall(text, text.length);
		expect(r?.name).toBe('my_macro');
	});

	it('returns undefined when not inside any jinja tag', () => {
		expect(findEnclosingMacroCall('select my_macro(', 16)).toBeUndefined();
	});

	it('returns undefined when no open paren before cursor', () => {
		expect(findEnclosingMacroCall('{{ my_macro', 11)).toBeUndefined();
	});
});
