import { describe, it, expect } from 'vitest';
import { violationsFor, capCfg, mockDocument, cfg, model, sqlTok } from './helpers';
import { runNinja } from '../../ninja/engine';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.cap.literals';

const LITERAL_TYPES = new Set(['null', 'true', 'false']);

/**
 * Build a minimal SqlToken[] for NULL/TRUE/FALSE literals only,
 * skipping -- line comments, /* *\/ block comments, and string literals.
 */
function literalTokens(sql: string): SqlToken[] {
	const tokens: SqlToken[] = [];
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
			if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
				const start = i;
				i++;
				while (i < line.length) {
					const c = line.charCodeAt(i);
					if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) i++;
					else break;
				}
				const word = line.slice(start, i);
				if (LITERAL_TYPES.has(word.toLowerCase())) {
					const absStart = absoluteOffset + start;
					const absEnd = absoluteOffset + i - 1;
					tokens.push(sqlTok(word.toUpperCase(), absStart, absEnd, lineIdx, i));
				}
			} else {
				i++;
			}
		}
		absoluteOffset += line.length + 1;
	}
	return tokens;
}

function run(sql: string, config?: Partial<import('../../ninja/config').NinjaConfig>): ReturnType<typeof runNinja> {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: literalTokens(sql) });
	return runNinja(doc, m, [], cfg(config));
}

describe(RULE, () => {
	// ── Policy: lower ──────────────────────────────────────────────────────

	it('flags uppercase NULL when policy is lower', () => {
		const v = violationsFor(run('select NULL'), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('null');
	});

	it('passes lowercase null', () => {
		const v = violationsFor(run('select null'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags uppercase TRUE when policy is lower', () => {
		const v = violationsFor(run('select TRUE'), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('true');
	});

	it('flags uppercase FALSE when policy is lower', () => {
		const v = violationsFor(run('select FALSE'), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('false');
	});

	it('passes lowercase true and false', () => {
		const v = violationsFor(run('select true, false'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Policy: upper ──────────────────────────────────────────────────────

	it('flags lowercase null when policy is upper', () => {
		const v = violationsFor(run('select null', capCfg('literals', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('NULL');
	});

	it('flags lowercase true when policy is upper', () => {
		const v = violationsFor(run('select true', capCfg('literals', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('TRUE');
	});

	it('passes uppercase literals when policy is upper', () => {
		const v = violationsFor(run('select NULL, TRUE, FALSE', capCfg('literals', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent literal casing', () => {
		const v = violationsFor(run('select null, NULL', capCfg('literals', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('null');
	});

	it('passes consistent literal casing (all lower)', () => {
		const v = violationsFor(run('select null, null', capCfg('literals', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	it('passes consistent literal casing (all upper)', () => {
		const v = violationsFor(run('select NULL, NULL', capCfg('literals', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('fix targets the correct range', () => {
		const v = violationsFor(run('select NULL from t'), RULE);
		expect(v[0].range.start.character).toBe(7);
		expect(v[0].range.end.character).toBe(11);
	});

	// ── Multi-violation ────────────────────────────────────────────────────

	it('flags all mismatched literals in a query', () => {
		const v = violationsFor(run('select NULL, TRUE, FALSE'), RULE);
		expect(v.length).toBe(3);
	});

	// ── Comment skipping ──────────────────────────────────────────────────

	it('does not flag NULL inside a -- line comment', () => {
		const v = violationsFor(run('select 1 -- NULL here'), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag NULL inside a /* */ block comment', () => {
		const v = violationsFor(run('select 1 /* NULL here */'), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag null inside a string literal', () => {
		// sqlglot tokenises 'null' as a string, not a NULL token
		const v = violationsFor(run('select \'null\''), RULE);
		expect(v.length).toBe(0);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});
});
