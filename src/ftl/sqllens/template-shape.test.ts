/**
 * classifyMacroShape: the manifest-sourced expansion-shape classifier behind
 * AnvilTemplateProvider. The shape answer decides what parseTemplated fills
 * into a macro tag, so a wrong answer surfaces as a SQL syntax error (or a
 * silently mis-shaped parse) on a real model.
 */
import { describe, expect, it } from 'vitest';
import { classifyMacroShape } from './template-shape';
import type { TemplateCall } from './api';

const call = (name: string, args: (string | null)[]): TemplateCall => ({ name, args });

describe('classifyMacroShape — body-leading keyword (no call context)', () => {
	it('classifies a query-bodied macro as statement', () => {
		expect(classifyMacroShape('{% macro m() %} with a as (select 1) select * from a {% endmacro %}')).toBe('statement');
		expect(classifyMacroShape('{% macro m() %}select 1{% endmacro %}')).toBe('statement');
	});

	it('classifies a trailing-conjunct macro as conjunct', () => {
		expect(classifyMacroShape('{% macro m(c) %}and {{ c }} = false{% endmacro %}')).toBe('conjunct');
	});

	it('answers nothing for an unknown-shaped body (identifier fill)', () => {
		expect(classifyMacroShape('{% macro m() %}{{ x }}::int{% endmacro %}')).toBeUndefined();
		expect(classifyMacroShape(undefined)).toBeUndefined();
	});
});

describe('classifyMacroShape — literal call args bound to parameters', () => {
	// The Oatly generic_is_deleted family: the MODE is an argument —
	// `{{ stat }} {{ column_name }}=false` — so the body alone classifies as
	// nothing. The call site carries the literal mode word; binding it lets the
	// and-mode call classify as a conjunct.
	const MACRO = '{% macro generic_is_deleted(column_name,stat) %}\n    {{ stat }} {{ column_name }}=false\n{% endmacro %}';

	it("classifies the and-mode call as conjunct via the bound 'stat' literal", () => {
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'and']))).toBe('conjunct');
	});

	it('keeps the identifier fill when the mode arg is not a literal', () => {
		// literalOf answers null for computed/non-string args — nothing to bind.
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', [null, null]))).toBeUndefined();
	});

	it('binds kwargs the same way', () => {
		expect(classifyMacroShape(MACRO, {
			name: 'generic_is_deleted',
			args: [],
			kwargs: [{ name: 'stat', value: 'and' }, { name: 'column_name', value: 'x' }],
		})).toBe('conjunct');
	});

	it('pins the where-mode call as unclassified — no where-clause shape exists yet', () => {
		// conjunct's `AND 1=1` fill would regress the `from t {{ m('where') }}`
		// slot, and the shape vocabulary has no where-clause entry. Stays the
		// identifier fill until sqllens ships one (channel: sqllens-anvil).
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'where']))).toBeUndefined();
	});
});
