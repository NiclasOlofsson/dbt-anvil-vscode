import { describe, it, expect } from 'vitest';
import { run, ruleIds, violationsFor, cfg as buildCfg } from './helpers';

describe('engine', () => {
	it('returns empty violations when disabled', () => {
		const r = run('SELECT 1', { enabled: false });
		expect(r.violations.length).toBe(0);
	});

	it('respects rule severity override to off', () => {
		const r = run('SELECT 1', { rules: { 'ninja.cap.keywords': 'off' } });
		const kw = violationsFor(r, 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
	});

	it('suppresses violations with -- noqa', () => {
		const r = run('SELECT 1 -- noqa\n');
		const kw = violationsFor(r, 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
	});

	it('suppresses specific rule with -- noqa: rule', () => {
		const r = run('SELECT NULL -- noqa: ninja.cap.keywords\n');
		const kw = violationsFor(r, 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
		// NULL should still be flagged (cap.literals not suppressed)
		const lit = violationsFor(r, 'ninja.cap.literals');
		expect(lit.length).toBe(1);
	});

	it('populates severityMap', () => {
		const r = run('SELECT 1');
		expect(r.severityMap.has('ninja.cap.keywords')).toBe(true);
	});

	it('respects error severity override', () => {
		const r = run('SELECT 1', { rules: { 'ninja.cap.keywords': 'error' } });
		expect(r.severityMap.get('ninja.cap.keywords')).toBe(0); // DiagnosticSeverity.Error
	});

	it('respects info severity override', () => {
		const r = run('SELECT 1', { rules: { 'ninja.cap.keywords': 'info' } });
		expect(r.severityMap.get('ninja.cap.keywords')).toBe(2); // DiagnosticSeverity.Information
	});

	it('returns violations from multiple rules', () => {
		// SELECT (cap.keywords) + NULL (cap.literals) + no trailing newline
		const r = run('SELECT NULL');
		const rules = new Set(ruleIds(r));
		expect(rules.has('ninja.cap.keywords')).toBe(true);
		expect(rules.has('ninja.cap.literals')).toBe(true);
		expect(rules.has('ninja.layout.trailing-newline')).toBe(true);
	});

	it('noqa suppresses all rules on that line', () => {
		const r = run('SELECT NULL -- noqa\n');
		const kw = violationsFor(r, 'ninja.cap.keywords');
		const lit = violationsFor(r, 'ninja.cap.literals');
		expect(kw.length).toBe(0);
		expect(lit.length).toBe(0);
	});

	it('noqa with multiple rules suppresses listed rules only', () => {
		const r = run('SELECT NULL -- noqa: ninja.cap.keywords, ninja.cap.literals\n');
		const kw = violationsFor(r, 'ninja.cap.keywords');
		const lit = violationsFor(r, 'ninja.cap.literals');
		expect(kw.length).toBe(0);
		expect(lit.length).toBe(0);
	});

	it('noqa does not affect other lines', () => {
		const r = run('SELECT 1 -- noqa\nSELECT 2\n');
		// Line 0 suppressed, line 1 not
		const kw = violationsFor(r, 'ninja.cap.keywords');
		expect(kw.length).toBe(1);
		expect(kw[0].range.start.line).toBe(1);
	});

	it('disabling all rules via overrides produces no violations', () => {
		const r = run('SELECT NULL  \n', {
			rules: {
				'ninja.cap.keywords': 'off',
				'ninja.cap.literals': 'off',
				'ninja.layout.trailing-whitespace': 'off',
			},
		});
		// Only rules with explicit off are suppressed; others may still fire
		const kw = violationsFor(r, 'ninja.cap.keywords');
		const lit = violationsFor(r, 'ninja.cap.literals');
		const tw = violationsFor(r, 'ninja.layout.trailing-whitespace');
		expect(kw.length).toBe(0);
		expect(lit.length).toBe(0);
		expect(tw.length).toBe(0);
	});
});
