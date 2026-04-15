import { describe, it, expect } from 'vitest';
import { ruleIds, violationsFor, mockDocument, cfg as buildCfg, model, sqlTok } from './helpers';
import { runNinja } from '../../ninja/engine';
import type { SqlToken } from '../../ftl/parse-result';

// SQL keyword token types (subset sufficient for engine tests)
const KEYWORD_TYPES = new Set([
	'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
	'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
	'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all',
	'distinct', 'case', 'when', 'then', 'else', 'end', 'with', 'recursive',
	'true', 'false', 'cast',
]);

/**
 * Build SqlToken[] for keyword and literal tokens, skipping -- line comments,
 * block comments, and string literals.
 */
function tokens(sql: string): SqlToken[] {
	const result: SqlToken[] = [];
	const lines = sql.split('\n');
	let absoluteOffset = 0;
	let inBlock = false;

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		let i = 0;
		while (i < line.length) {
			if (inBlock) {
				if (line[i] === '*' && line[i + 1] === '/') { i += 2; inBlock = false; }
				else i++;
				continue;
			}
			if (line[i] === '-' && line[i + 1] === '-') break;
			if (line[i] === '/' && line[i + 1] === '*') { i += 2; inBlock = true; continue; }
			if (line[i] === '\'') {
				i++;
				while (i < line.length && line[i] !== '\'') { if (line[i] === '\\') i++; i++; }
				i++; continue;
			}
			const ch = line.charCodeAt(i);
			if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
				const start = i;
				i++;
				while (i < line.length) {
					const c = line.charCodeAt(i);
					if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) i++;
					else break;
				}
				const word = line.slice(start, i);
				if (KEYWORD_TYPES.has(word.toLowerCase())) {
					const absStart = absoluteOffset + start;
					const absEnd = absoluteOffset + i - 1;
					result.push(sqlTok(word.toUpperCase(), absStart, absEnd, lineIdx, i));
				}
			} else {
				i++;
			}
		}
		absoluteOffset += line.length + 1;
	}
	return result;
}

function run(sql: string, config?: Partial<import('../../ninja/config').NinjaConfig>): ReturnType<typeof runNinja> {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens(sql) });
	return runNinja(doc, m, [], buildCfg(config));
}

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
