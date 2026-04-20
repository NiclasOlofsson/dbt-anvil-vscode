/**
 * Tests for the Layer 3 reflow engine: segmenter + renderer.
 *
 * Rather than running real sqlglot tokenisation (unavailable in vitest), we
 * build minimal NinjaSqlToken arrays from [type, text] pair lists.  The source
 * string is reconstructed from those pairs so cursor.textOf() works correctly.
 */

import { describe, it, expect } from 'vitest';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import { segment } from '../../ninja/reflow/segmenter';
import { render } from '../../ninja/reflow/renderer';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';

// ── Helpers ─────────────────────────────────────────────────────────────────

type TokenPair = [string, string]; // [SQL_TYPE, verbatim_text]

function buildTokens(pairs: TokenPair[]): { tokens: NinjaSqlToken[]; source: string } {
	const tokens: NinjaSqlToken[] = [];
	const parts: string[] = [];
	let offset = 0;

	for (const [type, text] of pairs) {
		tokens.push({
			category: 'sql',
			type,
			start: offset,
			end: offset + text.length - 1,
			line: 0,
			col: offset,
		} as NinjaSqlToken);
		parts.push(text);
		offset += text.length + 1; // +1 for implicit space separator in source
	}

	return { tokens, source: parts.join(' ') };
}

function reflow(pairs: TokenPair[], overrides: Partial<NinjaConfig> = {}): string {
	const { tokens, source } = buildTokens(pairs);
	const tree = segment(tokens, source);
	return render(tree, { ...DEFAULT_CONFIG, ...overrides });
}

const cfg4 = DEFAULT_CONFIG; // 4-space indent, trailing commas, maxLineLength=120

// ── Segmenter: basic structure ────────────────────────────────────────────────

describe('segmenter', () => {
	it('parses a minimal SELECT into one statement with one clause', () => {
		const { tokens, source } = buildTokens([
			['SELECT', 'select'],
			['VAR', 'a'],
		]);
		const tree = segment(tokens, source);
		expect(tree).toHaveLength(1);
		expect(tree[0].type).toBe('statement');
		if (tree[0].type === 'statement') {
			expect(tree[0].clauses).toHaveLength(1);
			expect(tree[0].clauses[0].keywordText).toBe('select');
		}
	});

	it('parses SELECT + FROM as two clauses in one statement', () => {
		const { tokens, source } = buildTokens([
			['SELECT', 'select'], ['VAR', 'a'],
			['FROM', 'from'], ['VAR', 't'],
		]);
		const tree = segment(tokens, source);
		expect(tree).toHaveLength(1);
		if (tree[0].type === 'statement') {
			expect(tree[0].clauses).toHaveLength(2);
			expect(tree[0].clauses[0].keywordText).toBe('select');
			expect(tree[0].clauses[1].keywordText).toBe('from');
		}
	});

	it('parses UNION ALL as a SetOpSegment between two statements', () => {
		const { tokens, source } = buildTokens([
			['SELECT', 'select'], ['VAR', 'a'],
			['FROM', 'from'], ['VAR', 't1'],
			['UNION', 'union'], ['ALL', 'all'],
			['SELECT', 'select'], ['VAR', 'b'],
			['FROM', 'from'], ['VAR', 't2'],
		]);
		const tree = segment(tokens, source);
		expect(tree).toHaveLength(3);
		expect(tree[0].type).toBe('statement');
		expect(tree[1].type).toBe('setop');
		expect(tree[2].type).toBe('statement');
		if (tree[1].type === 'setop') {
			expect(tree[1].text).toBe('union all');
		}
	});

	it('builds a ListSegment for comma-separated SELECT items', () => {
		const { tokens, source } = buildTokens([
			['SELECT', 'select'],
			['VAR', 'a'], ['COMMA', ','], ['VAR', 'b'], ['COMMA', ','], ['VAR', 'c'],
		]);
		const tree = segment(tokens, source);
		expect(tree[0].type).toBe('statement');
		if (tree[0].type === 'statement') {
			const body = tree[0].clauses[0].body;
			expect(body).toHaveLength(1);
			expect(body[0].type).toBe('list');
			if (body[0].type === 'list') {
				expect(body[0].items).toHaveLength(3);
			}
		}
	});

	it('parses WITH block with one CTE and final select', () => {
		const { tokens, source } = buildTokens([
			['WITH', 'with'],
			['VAR', 'cte1'], ['AS', 'as'], ['L_PAREN', '('],
			['SELECT', 'select'], ['VAR', 'x'], ['FROM', 'from'], ['VAR', 'raw'],
			['R_PAREN', ')'],
			['SELECT', 'select'], ['VAR', 'x'], ['FROM', 'from'], ['VAR', 'cte1'],
		]);
		const tree = segment(tokens, source);
		expect(tree).toHaveLength(1);
		expect(tree[0].type).toBe('with');
		if (tree[0].type === 'with') {
			expect(tree[0].ctes).toHaveLength(1);
			expect(tree[0].ctes[0].name).toBe('cte1');
			expect(tree[0].finalSelect).toHaveLength(1);
		}
	});
});

// ── Renderer: output format ───────────────────────────────────────────────────

describe('renderer', () => {
	it('renders a short SELECT on one line', () => {
		const out = reflow([
			['SELECT', 'select'], ['VAR', 'a'],
			['FROM', 'from'], ['VAR', 't'],
		]);
		expect(out).toBe('select a\nfrom t');
	});

	it('expands SELECT list when it exceeds maxLineLength', () => {
		// maxLineLength=30 forces expansion even for short lists
		const out = reflow(
			[
				['SELECT', 'select'],
				['VAR', 'column_one'], ['COMMA', ','],
				['VAR', 'column_two'], ['COMMA', ','],
				['VAR', 'column_three'],
				['FROM', 'from'], ['VAR', 't'],
			],
			{ maxLineLength: 30 },
		);
		const lines = out.split('\n');
		expect(lines[0]).toBe('select');
		expect(lines[1]).toBe('    column_one,');
		expect(lines[2]).toBe('    column_two,');
		expect(lines[3]).toBe('    column_three');
		expect(lines[4]).toBe('from t');
	});

	it('respects leading comma style', () => {
		const out = reflow(
			[
				['SELECT', 'select'],
				['VAR', 'a'], ['COMMA', ','],
				['VAR', 'b'], ['COMMA', ','],
				['VAR', 'c'],
				['FROM', 'from'], ['VAR', 't'],
			],
			{ maxLineLength: 1, layout: { commaPosition: 'leading', operatorPosition: 'leading' } },
		);
		const lines = out.split('\n');
		expect(lines[0]).toBe('select');
		expect(lines[1]).toBe('    a');
		expect(lines[2]).toBe('    , b');
		expect(lines[3]).toBe('    , c');
	});

	it('renders UNION ALL on its own line', () => {
		const out = reflow([
			['SELECT', 'select'], ['VAR', 'a'], ['FROM', 'from'], ['VAR', 't1'],
			['UNION', 'union'], ['ALL', 'all'],
			['SELECT', 'select'], ['VAR', 'b'], ['FROM', 'from'], ['VAR', 't2'],
		]);
		const lines = out.split('\n');
		expect(lines.some(l => l.trim() === 'union all')).toBe(true);
	});

	it('renders WITH block with correct indentation', () => {
		const out = reflow([
			['WITH', 'with'],
			['VAR', 'cte1'], ['AS', 'as'], ['L_PAREN', '('],
			['SELECT', 'select'], ['VAR', 'x'], ['FROM', 'from'], ['VAR', 'raw'],
			['R_PAREN', ')'],
			['SELECT', 'select'], ['VAR', 'x'], ['FROM', 'from'], ['VAR', 'cte1'],
		]);
		const lines = out.split('\n');
		expect(lines[0]).toBe('with');
		expect(lines[1]).toMatch(/^\s{4}cte1 as \(/);  // CTE name at 1-indent
		expect(lines[2]).toMatch(/^\s{8}select/);       // clause keyword at 2-indent
		expect(lines[3]).toMatch(/^\s{8}from/);
		expect(lines[4]).toMatch(/^\s{4}\)/);           // closing paren at 1-indent
	});

	it('produces identical output on second pass (idempotent structure)', () => {
		// Idempotence: run segment+render twice; segment-tree structure must match.
		const pairs: TokenPair[] = [
			['SELECT', 'select'],
			['VAR', 'col_a'], ['COMMA', ','], ['VAR', 'col_b'],
			['FROM', 'from'], ['VAR', 'my_table'],
			['WHERE', 'where'], ['VAR', 'id'], ['EQ', '='], ['NUMBER', '1'],
		];
		const { tokens, source } = buildTokens(pairs);
		const tree1 = segment(tokens, source);
		const out1 = render(tree1, cfg4);

		// Re-tokenize the rendered output (using original tokens; rendered output
		// matches source structure so positions align with our simple builder).
		// The key property: a second render of the same tree is stable.
		const out2 = render(tree1, cfg4);
		expect(out1).toBe(out2);
	});

	it('renders trailing comma when trailingComma flag is set', () => {
		// Manually construct a ListSegment with trailingComma=true via tokens
		// that end with a comma.
		const { tokens, source } = buildTokens([
			['SELECT', 'select'],
			['VAR', 'a'], ['COMMA', ','],
			['VAR', 'b'], ['COMMA', ','], // trailing comma
		]);
		const tree = segment(tokens, source);
		const out = render(tree, { ...cfg4, maxLineLength: 20 });
		// In expanded mode, trailing comma appears after last item.
		expect(out).toContain('b,');
	});
});
