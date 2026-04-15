import { describe, it, expect } from 'vitest';
import { violationsFor, capCfg, mockDocument, cfg, model, sqlTok } from './helpers';
import { runNinja } from '../../ninja/engine';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.cap.keywords';

// SQL keywords recognised by sqlglot — stored lowercase for comparison.
const KEYWORD_TYPES = new Set([
	'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
	'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
	'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all',
	'distinct', 'case', 'when', 'then', 'else', 'end', 'with', 'recursive',
	'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table',
	'drop', 'alter', 'index', 'view', 'if', 'exists', 'between', 'like',
	'ilike', 'asc', 'desc', 'nulls', 'first', 'last', 'over', 'partition',
	'window', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current',
	'row', 'except', 'intersect', 'true', 'false', 'cast', 'using', 'natural',
	'lateral', 'any', 'some', 'qualify', 'for', 'fetch', 'next', 'only',
	'top', 'returning', 'do', 'nothing', 'replace', 'ignore',
	'temporary', 'temp', 'materialized', 'unique', 'primary', 'key', 'foreign',
	'references', 'constraint', 'check', 'default', 'cascade', 'restrict',
	'no', 'action', 'grant', 'revoke', 'begin', 'commit', 'rollback',
	'savepoint', 'release', 'transaction', 'explain', 'analyze', 'type', 'interval',
]);

/**
 * Build a minimal SqlToken[] by scanning the SQL for keyword words only,
 * skipping -- line comments and /* *\/ block comments.
 * Used so unit tests don't need pyodide.
 */
function keywordTokens(sql: string): SqlToken[] {
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
					tokens.push(sqlTok(word.toUpperCase(), absStart, absEnd, lineIdx, i));
				}
			} else {
				i++;
			}
		}
		absoluteOffset += line.length + 1; // +1 for \n
	}
	return tokens;
}

function run(sql: string, config?: Partial<import('../../ninja/config').NinjaConfig>): ReturnType<typeof runNinja> {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: keywordTokens(sql) });
	return runNinja(doc, m, [], cfg(config));
}

describe(RULE, () => {
	// ── Policy: lower ──────────────────────────────────────────────────────

	it('flags uppercase keyword when policy is lower', () => {
		const v = violationsFor(run('SELECT 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('select');
	});

	it('passes when keyword matches lower policy', () => {
		const v = violationsFor(run('select 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(0);
	});

	it('flags multiple uppercase keywords', () => {
		const v = violationsFor(run('SELECT 1 FROM t WHERE x = 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(3); // SELECT, FROM, WHERE
	});

	it('flags mixed-case keyword when policy is lower', () => {
		const v = violationsFor(run('Select 1', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('select');
	});

	// ── Policy: upper ──────────────────────────────────────────────────────

	it('flags lowercase keyword when policy is upper', () => {
		const v = violationsFor(run('select 1', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('SELECT');
	});

	it('passes when keyword matches upper policy', () => {
		const v = violationsFor(run('SELECT 1', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	it('flags mixed-case keyword when policy is upper', () => {
		const v = violationsFor(run('Select 1 From t', capCfg('keywords', 'upper')), RULE);
		expect(v.length).toBe(2);
		expect(v[0].fix![0].newText).toBe('SELECT');
		expect(v[1].fix![0].newText).toBe('FROM');
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent keywords (first lower, then upper)', () => {
		const v = violationsFor(run('select 1\nSELECT 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('select');
	});

	it('flags inconsistent keywords (first upper, then lower)', () => {
		const v = violationsFor(run('SELECT 1\nselect 2', capCfg('keywords', 'upper')), RULE);
		const v2 = violationsFor(run('SELECT 1\nselect 2', capCfg('keywords', 'consistent')), RULE);
		expect(v2.length).toBe(1);
		expect(v2[0].fix![0].newText).toBe('SELECT');
	});

	it('passes consistent keywords (all lower)', () => {
		const v = violationsFor(run('select 1\nselect 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	it('passes consistent keywords (all upper)', () => {
		const v = violationsFor(run('SELECT 1\nSELECT 2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	it('tracks consistency per-keyword independently', () => {
		// 'select' first lower, 'from' first upper — both consistent within themselves
		const v = violationsFor(run('select 1 FROM t\nselect 2 FROM t2', capCfg('keywords', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('provides auto-fix with correct range', () => {
		const r = run('SELECT 1');
		const v = violationsFor(r, RULE);
		expect(v[0].fix).toBeDefined();
		expect(v[0].fix![0].newText).toBe('select');
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].range.end.character).toBe(6);
	});

	it('fix targets the correct word on multi-keyword line', () => {
		const v = violationsFor(run('SELECT 1 FROM t', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(2);
		// SELECT at col 0
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].fix![0].newText).toBe('select');
		// FROM at col 9
		expect(v[1].range.start.character).toBe(9);
		expect(v[1].fix![0].newText).toBe('from');
	});

	// ── Identifier skipping ────────────────────────────────────────────────

	it('only flags tokens that are in sqlTokens — non-keyword VAR tokens are not flagged', () => {
		// The parser produces a VAR token for identifiers, not a keyword token.
		// Only SELECT at col 0 and FROM are in sqlTokens; 'SELECT' at col 7 is absent
		// (simulating the parser classifying it as VAR, not a keyword).
		const sql = 'SELECT SELECT FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),   // keyword at col 0
			sqlTok('FROM', 14, 17, 0, 18),   // FROM keyword
			// 'SELECT' at col 7 intentionally absent
		];
		const doc = mockDocument(sql);
		const m = model({ sqlTokens: tokens });
		const v = violationsFor(runNinja(doc, m, [], cfg(capCfg('keywords', 'lower'))), RULE);
		const flaggedCols = v.map(x => x.range.start.character);
		expect(flaggedCols).toContain(0);   // SELECT at col 0 is flagged
		expect(flaggedCols).toContain(14);  // FROM is flagged
		expect(flaggedCols).not.toContain(7); // 'SELECT' at col 7 not in sqlTokens — not flagged
	});

	// ── Multi-line ─────────────────────────────────────────────────────────

	it('flags keywords across multiple lines', () => {
		const sql = 'SELECT\n    1\nFROM\n    t\nWHERE\n    x = 1\n';
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(3);
		expect(v[0].range.start.line).toBe(0);
		expect(v[1].range.start.line).toBe(2);
		expect(v[2].range.start.line).toBe(4);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag numbers or symbols', () => {
		const v = violationsFor(run('select 123, *, \'hello\'', capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(0);
	});

	it('handles CTE with keyword-like names', () => {
		const sql = 'with orders as (select 1)\nselect * from orders\n';
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		// 'with', 'as', 'select', 'from' are all lower — should pass
		expect(v.length).toBe(0);
	});

	// ── Comment lines must be ignored ─────────────────────────────────────

	it('does not flag uppercase keywords inside a -- line comment', () => {
		const sql = [
			'select',
			'    i.scenario_id,',
			'    s.game_id',
			'from cte_scenario_gen as i',
			'cross join nba_schedules as s',
			'    -- LEFT JOIN other_table AS r ON r.game_id = s.game_id',
			'    -- WHERE r.game_id IS NULL',
		].join('\n');
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		// LEFT, JOIN, AS, ON, WHERE, IS, NULL are all inside comments — zero violations
		expect(v.length).toBe(0);
	});

	it('does not flag uppercase keywords inside a /* */ block comment', () => {
		const sql = [
			'select id',
			'from orders',
			'/* WHERE status = \'active\'',
			'   AND id > 0 */',
		].join('\n');
		const v = violationsFor(run(sql, capCfg('keywords', 'lower')), RULE);
		expect(v.length).toBe(0);
	});
});
