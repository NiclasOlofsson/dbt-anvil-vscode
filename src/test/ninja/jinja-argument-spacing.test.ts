import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, applyEditsToText } from './helpers';
import { jinjaArgumentSpacingRule } from '../../ninja/rules/jinja-argument-spacing';
import { normaliseTagSpacing, normaliseArgumentSpacing } from '../../ninja/jinja/tag-formatter';
import { parseTemplated } from '../../ftl/sqllens/api';
import { jinjaTokensFromStream } from '../../ftl/sqllens/extract/jinja-stream';
import type { NinjaViolation } from '../../ninja/violation';
import { FixAction } from '../../ninja/violation';

/** Fine jinja stream from the live producer (sqllens templated front end). */
function tokenizeJinja(sql: string): ReturnType<typeof jinjaTokensFromStream> {
	const t = parseTemplated(sql, 'databricks');
	return jinjaTokensFromStream(t.tokens, t.tags, sql);
}

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

	// Multiline tags are no longer skipped: their argument spacing is normalised
	// while padding and line breaks are preserved (single-line padding is not
	// forced, so a newline right after `{{` survives).
	it('normalises args inside a multiline tag, preserving padding and line breaks', () => {
		const input = '{{ config(\n    tags=[\'a\',\'b\'],materialized=\'t\'\n) }}';
		const expected = '{{ config(\n    tags=[\'a\', \'b\'], materialized=\'t\'\n) }}';
		expect(normaliseTagSpacing(input)).toBe(expected);
	});

	it('returns null for a correctly-spaced multiline tag', () => {
		expect(normaliseTagSpacing('{{\n    config(materialized="table")\n}}')).toBeNull();
	});

	it('fixes args in a newline-padded tag without collapsing the padding', () => {
		expect(normaliseTagSpacing('{{\n    ref(\'a\',\'b\')\n}}')).toBe('{{\n    ref(\'a\', \'b\')\n}}');
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

	// ── De-overlap: padding is NOT this rule's concern ───────────────────────

	it('does not flag a padding-only expression tag (jinja.padding owns padding)', () => {
		expect(check('{{ref(\'orders\')}}')).toHaveLength(0);
	});

	it('does not flag a padding-only block tag', () => {
		expect(check('{%if true%}')).toHaveLength(0);
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

	it('autofix: comma fixed without adding delimiter padding', () => {
		expect(applyFixes('{{ref(\'a\',\'b\')}}')).toBe('{{ref(\'a\', \'b\')}}');
	});

	it('autofix: adds comma space in source()', () => {
		expect(applyFixes('{{ source(\'raw\',\'orders\') }}')).toBe('{{ source(\'raw\', \'orders\') }}');
	});

	it('autofix: removes kwarg spaces', () => {
		expect(applyFixes('{{ ref(\'orders\', package = \'pkg\') }}')).toBe('{{ ref(\'orders\', package=\'pkg\') }}');
	});

	it('autofix: fixes comma but leaves the delimiter padding to jinja.padding', () => {
		expect(applyFixes('{{source(\'raw\',\'orders\')}}')).toBe('{{source(\'raw\', \'orders\')}}');
	});

	it('autofix: fixes comma but leaves whitespace-control dashes untouched', () => {
		expect(applyFixes('{{-ref(\'a\',\'b\')-}}')).toBe('{{-ref(\'a\', \'b\')-}}');
	});

	it('autofix: fixes argument spacing inside a multiline tag, keeping line breaks', () => {
		const input = '{{ config(\n    tags=[\'a\',\'b\'],materialized=\'t\'\n) }}';
		const expected = '{{ config(\n    tags=[\'a\', \'b\'], materialized=\'t\'\n) }}';
		expect(applyFixes(input)).toBe(expected);
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

// ── Unit tests: normaliseArgumentSpacing ────────────────────────────────────
// Args-only: normalises commas and kwarg `=`, NEVER the delimiter padding (that
// is `ninja.jinja.padding`'s job), and preserves author line breaks so it works
// inside a multiline tag.

describe('normaliseArgumentSpacing', () => {
	it('adds a space after a comma', () => {
		expect(normaliseArgumentSpacing('{{ ref(\'a\',\'b\') }}')).toBe('{{ ref(\'a\', \'b\') }}');
	});

	it('removes spaces around a kwarg =', () => {
		expect(normaliseArgumentSpacing('{{ config(x = 1) }}')).toBe('{{ config(x=1) }}');
	});

	it('removes spaces around = consistently for list and dict values', () => {
		expect(normaliseArgumentSpacing('{{ config(tags = [\'a\']) }}')).toBe('{{ config(tags=[\'a\']) }}');
		expect(normaliseArgumentSpacing('{{ config(meta = {\'k\': 1}) }}')).toBe('{{ config(meta={\'k\': 1}) }}');
	});

	it('returns null when args are already correct', () => {
		expect(normaliseArgumentSpacing('{{ ref(\'a\', \'b\') }}')).toBeNull();
	});

	it('does not touch a comma inside a string literal', () => {
		expect(normaliseArgumentSpacing('{{ var(\'a,b\') }}')).toBeNull();
	});

	// De-overlap: padding is NOT this function's concern.
	it('does not add missing delimiter padding while fixing a comma', () => {
		expect(normaliseArgumentSpacing('{{ref(\'a\',\'b\')}}')).toBe('{{ref(\'a\', \'b\')}}');
	});

	it('does not collapse extra delimiter padding', () => {
		expect(normaliseArgumentSpacing('{{  ref(\'a\', \'b\')  }}')).toBeNull();
	});

	it('returns null for a padding-only issue (no args to fix)', () => {
		expect(normaliseArgumentSpacing('{{ref(\'x\')}}')).toBeNull();
	});

	// Newline-aware: normalise same-line spacing, preserve line breaks/indent.
	it('normalises mid-line commas inside a multiline tag, keeping line breaks', () => {
		const input = '{{ config(\n    tags=[\'a\',\'b\'],materialized=\'t\'\n) }}';
		const expected = '{{ config(\n    tags=[\'a\', \'b\'], materialized=\'t\'\n) }}';
		expect(normaliseArgumentSpacing(input)).toBe(expected);
	});

	it('does not add a space after a comma at end of line', () => {
		expect(normaliseArgumentSpacing('{{ config(\n    a,\n    b\n) }}')).toBeNull();
	});
});
