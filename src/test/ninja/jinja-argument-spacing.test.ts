import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, applyEditsToText } from './helpers';
import { jinjaArgumentSpacingRule } from '../../ninja/rules/jinja-argument-spacing';
import { normaliseTagSpacing } from '../../ninja/jinja/tag-formatter';
import { tokenizeJinja } from '../../ftl/jinja-tokenizer';
import type { NinjaViolation } from '../../ninja/violation';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.jinja.argument-spacing';

// ── Helper ──────────────────────────────────────────────────────────────────

function check(sql: string): NinjaViolation[] {
	const doc = mockDocument(sql);
	const jinjaTokens = tokenizeJinja(sql);
	const m = model({ jinjaTokens });
	return jinjaArgumentSpacingRule.check({ model: m, document: doc, config: cfg() });
}

function applyFixes(sql: string): string {
	const doc = mockDocument(sql);
	const jinjaTokens = tokenizeJinja(sql);
	const m = model({ jinjaTokens });
	const violations = jinjaArgumentSpacingRule.check({ model: m, document: doc, config: cfg() });
	const ops = violations.flatMap(v => v.action?.type === FixAction.TYPE ? v.action.ops : []);
	return applyEditsToText(sql, ops);
}

// ── Unit tests: normaliseTagSpacing ─────────────────────────────────────────

describe('normaliseTagSpacing', () => {
	it('returns null for already-correct expression tag', () => {
		expect(normaliseTagSpacing('{{ x }}')).toBeNull();
	});

	it('returns null for already-correct ref tag', () => {
		expect(normaliseTagSpacing('{{ ref(\'orders\') }}')).toBeNull();
	});

	it('returns null for already-correct block tag', () => {
		expect(normaliseTagSpacing('{% if x %}')).toBeNull();
	});

	it('adds padding inside expression delimiters', () => {
		expect(normaliseTagSpacing('{{x}}')).toBe('{{ x }}');
	});

	it('adds padding inside block delimiters', () => {
		expect(normaliseTagSpacing('{%if x%}')).toBe('{% if x %}');
	});

	it('collapses multiple spaces to single padding', () => {
		expect(normaliseTagSpacing('{{  x  }}')).toBe('{{ x }}');
	});

	it('preserves whitespace-control dash and adds padding', () => {
		expect(normaliseTagSpacing('{{-x-}}')).toBe('{{- x -}}');
	});

	it('preserves + whitespace-control modifier', () => {
		expect(normaliseTagSpacing('{{+x+}}')).toBe('{{+ x +}}');
	});

	it('normalises comma spacing — adds space after comma', () => {
		expect(normaliseTagSpacing('{{ ref(\'a\',\'b\') }}')).toBe('{{ ref(\'a\', \'b\') }}');
	});

	it('normalises comma spacing — removes extra spaces after comma', () => {
		expect(normaliseTagSpacing('{{ ref(\'a\',  \'b\') }}')).toBe('{{ ref(\'a\', \'b\') }}');
	});

	it('returns null when comma spacing is already correct', () => {
		expect(normaliseTagSpacing('{{ ref(\'a\', \'b\') }}')).toBeNull();
	});

	it('normalises kwarg = — removes spaces around equals', () => {
		expect(normaliseTagSpacing('{{ ref(\'x\', package = \'p\') }}')).toBe('{{ ref(\'x\', package=\'p\') }}');
	});

	it('returns null when kwarg = already has no spaces', () => {
		expect(normaliseTagSpacing('{{ ref(\'x\', package=\'p\') }}')).toBeNull();
	});

	it('does not modify == comparison operator', () => {
		expect(normaliseTagSpacing('{% if x == 1 %}')).toBeNull();
	});

	it('does not modify content inside string literals', () => {
		// The comma inside the string should not get a space added after it
		expect(normaliseTagSpacing('{{ var(\'key\', \'a,b\') }}')).toBeNull();
	});

	it('skips comment tags', () => {
		expect(normaliseTagSpacing('{# comment #}')).toBeNull();
	});

	it('skips multiline tags', () => {
		const multiline = '{{\n    config(materialized="table")\n}}';
		expect(normaliseTagSpacing(multiline)).toBeNull();
	});

	it('handles source() with two string args', () => {
		expect(normaliseTagSpacing('{{ source(\'raw\',\'orders\') }}')).toBe('{{ source(\'raw\', \'orders\') }}');
	});

	it('handles combined: missing padding + comma spacing', () => {
		expect(normaliseTagSpacing('{{source(\'raw\',\'orders\')}}')).toBe('{{ source(\'raw\', \'orders\') }}');
	});
});

// ── Rule integration tests ───────────────────────────────────────────────────

describe(RULE, () => {
	// ── No violations ───────────────────────────────────────────────────────

	it('passes correctly spaced expression tag', () => {
		expect(check('select * from {{ ref(\'orders\') }}')).toHaveLength(0);
	});

	it('passes correctly spaced block tag', () => {
		expect(check('{% if condition %}')).toHaveLength(0);
	});

	it('passes empty document', () => {
		expect(check('')).toHaveLength(0);
	});

	it('passes SQL with no jinja', () => {
		expect(check('select 1 from t')).toHaveLength(0);
	});

	// ── Missing padding ──────────────────────────────────────────────────────

	it('flags missing padding in expression delimiter', () => {
		const v = check('{{ref(\'orders\')}}');
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
	});

	it('flags missing padding in block delimiter', () => {
		const v = check('{%if true%}');
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
	});

	// ── Comma spacing ────────────────────────────────────────────────────────

	it('flags missing space after comma in source()', () => {
		const v = check('select * from {{ source(\'raw\',\'orders\') }}');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('→');
	});

	it('flags missing space after comma in ref with two args', () => {
		const v = check('{{ ref(\'model\',\'package\') }}');
		expect(v).toHaveLength(1);
	});

	// ── Kwarg spacing ────────────────────────────────────────────────────────

	it('flags spaces around = in kwargs', () => {
		const v = check('{{ ref(\'orders\', package = \'pkg\') }}');
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
	});

	// ── Autofix ──────────────────────────────────────────────────────────────

	it('autofix: adds padding to expression tag', () => {
		expect(applyFixes('{{ref(\'orders\')}}')).toBe('{{ ref(\'orders\') }}');
	});

	it('autofix: adds comma space in source()', () => {
		expect(applyFixes('{{ source(\'raw\',\'orders\') }}')).toBe('{{ source(\'raw\', \'orders\') }}');
	});

	it('autofix: removes kwarg spaces', () => {
		expect(applyFixes('{{ ref(\'orders\', package = \'pkg\') }}')).toBe('{{ ref(\'orders\', package=\'pkg\') }}');
	});

	it('autofix: combined padding + comma spacing', () => {
		expect(applyFixes('{{source(\'raw\',\'orders\')}}')).toBe('{{ source(\'raw\', \'orders\') }}');
	});

	it('autofix: preserves whitespace-control dashes', () => {
		expect(applyFixes('{{-ref(\'orders\')-}}')).toBe('{{- ref(\'orders\') -}}');
	});

	// ── No false positives ───────────────────────────────────────────────────

	it('does not flag comment tags', () => {
		expect(check('{# just a comment #}')).toHaveLength(0);
	});

	it('does not flag == comparison in block tag', () => {
		expect(check('{% if x == 1 %}')).toHaveLength(0);
	});

	it('does not modify comma inside string literals', () => {
		// No violation: comma is inside the string 'a,b', not between args
		expect(check('{{ var(\'key\', \'a,b\') }}')).toHaveLength(0);
	});
});
